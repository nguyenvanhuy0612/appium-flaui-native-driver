import { expect } from 'chai';
import http from 'node:http';
import { type AddressInfo } from 'node:net';
import { RpcClient } from '../../lib/backend/rpc-client';

describe('RpcClient', () => {
  let server: http.Server;
  let base: string;

  before((done) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/status') {
          res.end(JSON.stringify({ ok: true, ready: true }));
          return;
        }
        const op = JSON.parse(body || '{}');
        res.end(JSON.stringify({ ok: true, value: { echoed: op } }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });

  after((done) => server.close(() => done()));

  it('posts an op and returns the value', async () => {
    const client = new RpcClient(base);
    const res = await client.op({
      op: 'find',
      startId: 'root',
      multiple: false,
      scope: 'descendants',
      condition: { kind: 'true' },
    });
    expect(res).to.deep.equal({
      echoed: { op: 'find', startId: 'root', multiple: false, scope: 'descendants', condition: { kind: 'true' } },
    });
  });

  it('health() returns true when ready', async () => {
    const client = new RpcClient(base);
    expect(await client.health()).to.equal(true);
  });

  it('throws RpcError on { ok:false }', async () => {
    // A server that always returns an error envelope.
    const errServer = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: { type: 'no such element', message: 'nope' } }));
    });
    await new Promise<void>((r) => errServer.listen(0, '127.0.0.1', () => r()));
    const errBase = `http://127.0.0.1:${(errServer.address() as AddressInfo).port}`;
    const client = new RpcClient(errBase);
    let caught: unknown;
    try {
      await client.op({ op: 'source', startId: 'root' });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).to.equal('nope');
    expect((caught as { type: string }).type).to.equal('no such element');
    await new Promise<void>((r) => errServer.close(() => r()));
  });
});
