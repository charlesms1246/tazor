import { createServer } from 'node:http';
import { handlerFromEnv } from './env.ts';

const r = handlerFromEnv();
const port = Number(process.env.PORT ?? 8787);
createServer(r.handler).listen(port, '0.0.0.0', () => {
  console.log(`relayer on :${port} chain ${r.chainId} sender=${r.sender?.address ?? 'none'} paymentModule=${r.paymentModule} approverFactory=${r.approverFactory} revocationList=${r.revocationList} mandateModule=${r.mandateModule} paymaster=${r.paymaster ?? 'unset'}`);
});
