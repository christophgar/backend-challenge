import 'reflect-metadata';
import { Body, Catch, Controller, Get, Headers, HttpCode, HttpException, Injectable, Module, Param, Post, Query, Res, UseGuards, type ArgumentsHost, type ExceptionFilter, type CanActivate } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Response,Request as HttpRequest,NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { db } from './db';
import { AppError } from './contracts';
import { createWallet, fixed, getWallet, processWager, reconcile } from './service';
import { initQueues, ready, sqs } from './queue';
import { log, registry,withLogContext,currentCorrelationId,enrichLogContext } from './observability';

// Explicit extension point: replace with an external OIDC provider guard in production.
@Injectable()
class ProviderIdentityGuard implements CanActivate { canActivate() { return true; } }
@Catch()
class Errors implements ExceptionFilter {
  catch(error:unknown,host:ArgumentsHost) {
    const response=host.switchToHttp().getResponse<Response>();
    const status=error instanceof AppError?error.httpStatus:error instanceof ZodError?400:error instanceof HttpException?error.getStatus():503;
    const code=error instanceof AppError?error.code:error instanceof ZodError || status===400?'INVALID_PAYLOAD':status===404?'NOT_FOUND':'INFRASTRUCTURE_UNAVAILABLE';
    log('request_failed',{errorType:(error as Error)?.constructor?.name,httpStatus:status});
    response.status(status).json({code});
  }
}
@Controller()
@UseGuards(ProviderIdentityGuard)
class FinancialController {
  @Post('wallets') create(@Body() body:unknown) { return createWallet(body); }
  @Get('wallets/:id') wallet(@Param('id') id:string) { return getWallet(z.uuid().parse(id)); }
  @Post('wallets/:id/reconciliation') @HttpCode(200)
  reconcile(@Param('id') id:string) { return reconcile(z.uuid().parse(id)); }
  @Post('wagering/transactions')
  async wager(@Body() body:unknown,@Headers('idempotency-key') key:string,@Res() response:Response) {
    const result=await processWager(body,key,{correlationId:currentCorrelationId()});
    response.status(result.status==='PENDING_REFERENCE'?202:result.status==='REJECTED'?422:result.status==='FAILED'?500:200).json(result);
  }
  @Get('wagering/transactions/:id')
  async transaction(@Param('id') id:string) {
    const [row]=await db.query('SELECT result FROM transactions WHERE id=$1',[z.uuid().parse(id)]);
    if(!row) throw new AppError('TRANSACTION_NOT_FOUND',404); return row.result;
  }
  @Get('providers/:providerId/wagering/transactions/:externalId')
  async external(@Param('providerId') provider:string,@Param('externalId') external:string) {
    const [row]=await db.query('SELECT result FROM transactions WHERE provider_id=$1 AND external_id=$2',[provider,external]);
    if(!row) throw new AppError('TRANSACTION_NOT_FOUND',404); return row.result;
  }
  @Get('wallets/:id/ledger')
  async ledger(@Param('id') id:string,@Query('cursor') cursor?:string,@Query('limit') limitInput?:string) {
    z.uuid().parse(id); await getWallet(id);
    const limit=z.coerce.number().int().min(1).max(100).parse(limitInput ?? '50');
    let after='0';
    if(cursor) {
      try { const decoded=JSON.parse(Buffer.from(cursor,'base64url').toString());
        if(decoded.walletId!==id || !/^\d+$/.test(decoded.sequence)) throw new Error(); after=decoded.sequence;
      } catch { throw new AppError('INVALID_CURSOR',400); }
    }
    const rows=await db.query('SELECT * FROM ledger WHERE wallet_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3',[id,after,limit+1]);
    const more=rows.length>limit; const page=rows.slice(0,limit);
    return {items:page.map((r:Record<string,any>)=>({id:r.id,transactionId:r.transaction_id,direction:r.direction,money:{amount:fixed(r.amount),currency:r.currency},balanceBefore:{amount:fixed(r.balance_before),currency:r.currency},balanceAfter:{amount:fixed(r.balance_after),currency:r.currency},createdAt:r.created_at})),nextCursor:more?Buffer.from(JSON.stringify({walletId:id,sequence:page.at(-1).sequence})).toString('base64url'):null};
  }
}
@Controller()
class HealthController {
  @Get('health/live') live() { return {status:'ok'}; }
  @Get('health/ready') async ready() { await ready(); return {status:'ok'}; }
  @Get('metrics') async metrics(@Res() response:Response) { response.type(registry.contentType).send(await registry.metrics()); }
}
@Module({controllers:[FinancialController,HealthController],providers:[ProviderIdentityGuard]})
class AppModule {}
async function bootstrap() {
if(process.env.NODE_ENV==='production') throw new Error('External identity provider must be configured before production use');
await db.initialize();
await initQueues();
const app=await NestFactory.create(AppModule,{logger:false});
app.useGlobalFilters(new Errors());
app.use((req:HttpRequest,res:Response,next:NextFunction)=>{
  const correlationId=crypto.randomUUID();
  res.setHeader('X-Correlation-Id',correlationId);
  withLogContext({correlationId},()=>{
    const body=req.body;
    if(body && typeof body==='object')enrichLogContext({walletId:typeof body.walletId==='string'?body.walletId:undefined,providerId:typeof body.providerId==='string'?body.providerId:undefined});
    next();
  });
});
await app.listen(process.env.PORT ?? 3000,process.env.APP_HOST ?? '127.0.0.1');
log('api_started');
let stopping=false;
async function shutdown() { if(stopping) return; stopping=true; await app.close(); sqs.destroy(); await db.destroy(); }
process.on('SIGTERM',()=>void shutdown()); process.on('SIGINT',()=>void shutdown());
}
await bootstrap().catch(async error=>{
  log('startup_failed',{correlationId:crypto.randomUUID(),errorType:error?.constructor?.name});
  sqs.destroy();if(db.isInitialized)await db.destroy().catch(()=>{});process.exitCode=1;
});
