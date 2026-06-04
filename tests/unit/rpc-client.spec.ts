import { expect } from 'chai';
import http from 'node:http';
import { type AddressInfo } from 'node:net';
import { RpcClient, RpcError } from '../../lib/backend/rpc-client';

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

  it('F18: non-JSON 500 body -> RpcError("unknown error") not a SyntaxError', async () => {
    // Simulate a raw Kestrel 500 (HTML/plain text, not a {ok:false} envelope).
    const htmlServer = http.createServer((_req, res) => {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/html');
      res.end('<html><body>Internal Server Error</body></html>');
    });
    await new Promise<void>((r) => htmlServer.listen(0, '127.0.0.1', () => r()));
    const htmlBase = `http://127.0.0.1:${(htmlServer.address() as AddressInfo).port}`;
    const client = new RpcClient(htmlBase);
    let caught: unknown;
    try {
      await client.op({ op: 'source', startId: 'root' });
    } catch (e) {
      caught = e;
    }
    expect(caught, 'should throw').to.be.instanceOf(RpcError);
    expect((caught as RpcError).type).to.equal('unknown error');
    expect((caught as Error).message.toLowerCase()).to.match(/non-json|500/);
    await new Promise<void>((r) => htmlServer.close(() => r()));
  });

  it('D: a per-call timeout overrides the instance default (slow op aborts as transport, not RpcError)', async () => {
    const slow = http.createServer((_req, res) => {
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, value: {} }));
      }, 500);
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()));
    const slowBase = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    // Instance default is generous; the tight per-call 100ms wins and aborts the in-flight fetch.
    const client = new RpcClient(slowBase, 60_000);
    let caught: unknown;
    try {
      await client.op({ op: 'source', startId: 'root' }, 100);
    } catch (e) {
      caught = e;
    }
    expect(caught, 'should reject').to.exist;
    expect(caught, 'a transport abort is NOT a clean RpcError').to.not.be.instanceOf(RpcError);
    // A generous per-call timeout lets the very same slow op succeed.
    const ok = await client.op({ op: 'source', startId: 'root' }, 2_000);
    expect(ok).to.deep.equal({});
    await new Promise<void>((r) => slow.close(() => r()));
  });

  it('F18: 2xx-but-non-JSON body -> RpcError("unknown error")', async () => {
    const garbageServer = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('not json at all');
    });
    await new Promise<void>((r) => garbageServer.listen(0, '127.0.0.1', () => r()));
    const gBase = `http://127.0.0.1:${(garbageServer.address() as AddressInfo).port}`;
    const client = new RpcClient(gBase);
    let caught: unknown;
    try {
      await client.op({ op: 'source', startId: 'root' });
    } catch (e) {
      caught = e;
    }
    expect(caught, 'should throw').to.be.instanceOf(RpcError);
    expect((caught as RpcError).type).to.equal('unknown error');
    await new Promise<void>((r) => garbageServer.close(() => r()));
  });
});
