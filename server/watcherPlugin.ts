import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

export interface WatchedFilePayload {
  hasFile: boolean;
  filePath: string | null;
  relativePath: string | null;
  yaml: string | null;
  availableFiles: string[];
  updatedAt: number;
}

function discoverWorkspaceYamlFiles(rootDir: string): string[] {
  const results: string[] = [];
  const ignoreDirs = new Set(['node_modules', '.git', 'dist', '.vite']);

  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || ignoreDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) &&
        !entry.name.includes('lock')
      ) {
        results.push(path.relative(rootDir, full).replace(/\\/g, '/'));
      }
    }
  };

  walk(rootDir, 0);
  return results.sort();
}

export function attachNetvizApi(
  useMiddleware: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void,
  rootDir: string,
  initialFile?: string
) {
  let activeFilePath: string | null = initialFile ? path.resolve(rootDir, initialFile) : null;
  if (!activeFilePath) {
    const defaultExample = path.resolve(rootDir, 'examples/dc-evpn-k8s-5layer.yaml');
    if (fs.existsSync(defaultExample)) {
      activeFilePath = defaultExample;
    }
  }

  let fsWatcher: fs.FSWatcher | null = null;
  const sseClients = new Set<ServerResponse>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const buildPayload = (): WatchedFilePayload => {
    const availableFiles = discoverWorkspaceYamlFiles(rootDir);
    if (!activeFilePath || !fs.existsSync(activeFilePath)) {
      return {
        hasFile: false,
        filePath: activeFilePath,
        relativePath: activeFilePath ? path.relative(rootDir, activeFilePath) : null,
        yaml: null,
        availableFiles,
        updatedAt: Date.now(),
      };
    }
    const yaml = fs.readFileSync(activeFilePath, 'utf-8');
    return {
      hasFile: true,
      filePath: activeFilePath,
      relativePath: path.relative(rootDir, activeFilePath).replace(/\\/g, '/'),
      yaml,
      availableFiles,
      updatedAt: Date.now(),
    };
  };

  const broadcastUpdate = () => {
    const data = JSON.stringify(buildPayload());
    for (const client of sseClients) {
      client.write(`data: ${data}\n\n`);
    }
  };

  const setupWatcher = (targetPath: string | null) => {
    if (fsWatcher) {
      fsWatcher.close();
      fsWatcher = null;
    }
    if (!targetPath || !fs.existsSync(targetPath)) return;

    try {
      fsWatcher = fs.watch(targetPath, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          broadcastUpdate();
        }, 80);
      });
    } catch {
      // Ignore watch error if filesystem does not support watching
    }
  };

  setupWatcher(activeFilePath);

  useMiddleware((req, res, next) => {
    const url = req.url ? new URL(req.url, 'http://localhost') : null;
    if (!url || !url.pathname.startsWith('/api/')) {
      next();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/topology') {
      const requestedFile = url.searchParams.get('file');
      if (requestedFile) {
        const candidate = path.resolve(rootDir, requestedFile);
        if (fs.existsSync(candidate)) {
          activeFilePath = candidate;
          setupWatcher(activeFilePath);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildPayload()));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/topology') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { yaml?: string; filePath?: string };
          const target = parsed.filePath
            ? path.resolve(rootDir, parsed.filePath)
            : activeFilePath;
          if (!target) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No active file selected to save.' }));
            return;
          }
          if (typeof parsed.yaml === 'string') {
            fs.writeFileSync(target, parsed.yaml, 'utf-8');
            activeFilePath = target;
            setupWatcher(activeFilePath);
            broadcastUpdate();
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(buildPayload()));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(buildPayload())}\n\n`);
      sseClients.add(res);
      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    next();
  });

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (fsWatcher) {
      fsWatcher.close();
      fsWatcher = null;
    }
    sseClients.clear();
  };
}

export function netvizFileWatcherPlugin(): Plugin {
  return {
    name: 'netviz-yaml-watcher',
    configureServer(server) {
      if (process.env.VITEST) return;
      const targetFile = process.env.NETVIZ_FILE;
      const cleanup = attachNetvizApi(
        (fn) => server.middlewares.use(fn),
        server.config.root,
        targetFile
      );
      server.httpServer?.once('close', cleanup);
    },
  };
}
