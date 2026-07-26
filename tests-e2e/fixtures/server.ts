import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

export interface MockServer {
  port: number;
  stop(): Promise<void>;
}

export async function startMock(): Promise<MockServer> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/users' && req.method === 'GET') {
      const auth = req.headers.authorization;
      if (auth === 'Bearer T123') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ users: [{ id: 1, name: 'Test User' }] }));
        return;
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized', got: auth ?? null }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => { r(); }));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('failed to bind mock server');
  return {
    port: addr.port,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        }),
      ),
  };
}
