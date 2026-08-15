import * as fsp from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { WorkspaceConfig, WorkspaceService, workspaceEnvironment } from './workspaceConfig';

export type ServiceHealth = 'healthy' | 'unhealthy' | 'stopped' | 'unknown' | 'hidden' | 'malformed';

export interface ResolvedService {
  name: string;
  url?: string;
  port?: string;
  health: ServiceHealth;
  detail?: string;
}

/** Resolve provider-neutral service declarations without ever returning marked secrets. */
export async function resolveServices(
  config: WorkspaceConfig,
  worktreePath: string,
  rootPath: string,
  appRunning: boolean,
): Promise<ResolvedService[]> {
  const services = config.services ?? [];
  if (services.length === 0) {
    return [];
  }
  const secrets = new Set(config.environment?.secrets ?? []);
  return Promise.all(
    services.map(async (service) => {
      const cwd = path.resolve(worktreePath, service.cwd ?? config.cwd ?? '.');
      if (!isInside(worktreePath, cwd)) {
        return {
          name: service.name,
          health: 'malformed' as const,
          detail: 'Service working directory must stay inside the worktree',
        };
      }
      const environment = {
        ...workspaceEnvironment(worktreePath, rootPath),
        ...(await readEnvironment(cwd, config.environment?.files ?? ['.env', '.env.local'])),
      };
      return resolveService(service, environment, secrets, appRunning);
    }),
  );
}

async function resolveService(
  service: WorkspaceService,
  environment: Record<string, string>,
  secrets: Set<string>,
  appRunning: boolean,
): Promise<ResolvedService> {
  const variables = [...service.url.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(
    (match) => match[1],
  );
  if (variables.some((key) => secrets.has(key))) {
    return {
      name: service.name,
      health: 'hidden',
      detail: 'URL hidden because it references a secret environment value',
    };
  }
  const missing = variables.filter((key) => environment[key] === undefined);
  if (missing.length > 0) {
    return {
      name: service.name,
      health: 'malformed',
      detail: `Missing environment variable${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
    };
  }
  const rendered = service.url.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, key: string) => environment[key],
  );
  let url: URL;
  try {
    url = new URL(rendered);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('unsupported protocol');
    }
  } catch {
    return { name: service.name, health: 'malformed', detail: 'Service URL is invalid' };
  }
  if (!appRunning) {
    return { name: service.name, url: url.toString(), port: url.port, health: 'stopped' };
  }
  if (!service.healthcheck) {
    return { name: service.name, url: url.toString(), port: url.port, health: 'unknown' };
  }

  let healthUrl: URL;
  try {
    healthUrl = new URL(service.healthcheck, url);
  } catch {
    return {
      name: service.name,
      url: url.toString(),
      port: url.port,
      health: 'malformed',
      detail: 'Health-check URL is invalid',
    };
  }
  if (!isLocal(healthUrl.hostname)) {
    return {
      name: service.name,
      url: url.toString(),
      port: url.port,
      health: 'unknown',
      detail: 'Only local health checks are polled',
    };
  }
  const healthy = await probeService(healthUrl, 1500);
  return {
    name: service.name,
    url: url.toString(),
    port: url.port,
    health: healthy ? 'healthy' : 'unhealthy',
  };
}

export function probeService(url: URL, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, { method: 'GET', timeout: timeoutMs }, (response) => {
      response.resume();
      resolve((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 400);
    });
    request.once('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.once('error', () => resolve(false));
    request.end();
  });
}

function isLocal(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

async function readEnvironment(cwd: string, files: string[]): Promise<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const relative of files) {
    const file = path.resolve(cwd, relative);
    if (!isInside(cwd, file)) {
      continue;
    }
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) {
        continue;
      }
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      environment[match[1]] = value;
    }
  }
  return environment;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
