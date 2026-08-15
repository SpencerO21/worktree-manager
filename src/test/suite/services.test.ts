import * as assert from 'assert';
import * as fsp from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { resolveServices } from '../../services';
import { WorkspaceConfig } from '../../workspaceConfig';

describe('worktree services', () => {
  let worktree: string;

  beforeEach(async () => {
    worktree = await fsp.mkdtemp(path.join(os.tmpdir(), 'worktree-services-'));
  });

  afterEach(async () => {
    await fsp.rm(worktree, { recursive: true, force: true });
  });

  it('resolves multiple service URLs from local environment files', async () => {
    await fsp.writeFile(path.join(worktree, '.env'), 'WEB_PORT=4310\n');
    await fsp.mkdir(path.join(worktree, 'apps/api'), { recursive: true });
    await fsp.writeFile(path.join(worktree, 'apps/api/.env'), 'API_PORT=4311\n');
    const config: WorkspaceConfig = {
      services: [
        { name: 'Web', url: 'http://localhost:${WEB_PORT}' },
        { name: 'API', url: 'http://localhost:${API_PORT}', cwd: 'apps/api' },
      ],
    };

    const services = await resolveServices(config, worktree, worktree, false);

    assert.deepStrictEqual(services.map((service) => service.port), ['4310', '4311']);
    assert.deepStrictEqual(services.map((service) => service.health), ['stopped', 'stopped']);
  });

  it('reports healthy and unhealthy local checks', async () => {
    const server = http.createServer((request, response) => {
      response.statusCode = request.url === '/health' ? 204 : 503;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
      const base = `http://127.0.0.1:${address.port}`;
      const services = await resolveServices(
        {
          services: [
            { name: 'Healthy', url: base, healthcheck: '/health' },
            { name: 'Unhealthy', url: base, healthcheck: '/missing' },
          ],
        },
        worktree,
        worktree,
        true,
      );

      assert.deepStrictEqual(services.map((service) => service.health), ['healthy', 'unhealthy']);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });

  it('never renders URLs that reference marked secrets', async () => {
    await fsp.writeFile(path.join(worktree, '.env'), 'TOKEN=do-not-render\n');

    const [service] = await resolveServices(
      {
        environment: { files: ['.env'], secrets: ['TOKEN'] },
        services: [{ name: 'Admin', url: 'http://localhost/?token=${TOKEN}' }],
      },
      worktree,
      worktree,
      true,
    );

    assert.strictEqual(service.health, 'hidden');
    assert.strictEqual(service.url, undefined);
    assert.doesNotMatch(JSON.stringify(service), /do-not-render/);
  });

  it('marks missing values and invalid URLs without throwing', async () => {
    const services = await resolveServices(
      {
        services: [
          { name: 'Missing', url: 'http://localhost:${MISSING}' },
          { name: 'Broken', url: 'not a URL' },
        ],
      },
      worktree,
      worktree,
      true,
    );

    assert.deepStrictEqual(services.map((service) => service.health), ['malformed', 'malformed']);
  });
});
