#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
let targetFile = '';
let port = '5173';
let openBrowser = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help' || a === '-h') {
    console.log(`
NetViz — Multi-Layer Overlay & Physical Network Visualizer

Usage:
  npm start -- [path/to/network.yaml] [--port 5173] [--open]
  node ./bin/netviz.mjs [path/to/network.yaml] [--port 5173] [--open]

Examples:
  npm start -- examples/dc-evpn-k8s-5layer.yaml
  npm start -- examples/multi-site-wan-sdwan.yaml --port 4000
`);
    process.exit(0);
  } else if (a === '--port' || a === '-p') {
    port = args[++i] ?? '5173';
  } else if (a === '--open' || a === '-o') {
    openBrowser = true;
  } else if (!a.startsWith('-')) {
    targetFile = path.resolve(process.cwd(), a);
  }
}

if (targetFile && !fs.existsSync(targetFile)) {
  console.error(`Error: YAML file not found at "${targetFile}"`);
  process.exit(1);
}

const viteBin = path.resolve(projectRoot, 'node_modules/.bin/vite');
const viteArgs = ['--port', port];
if (openBrowser) viteArgs.push('--open');

console.log(`\n🌐 Starting NetViz Multi-Layer Network Visualizer...`);
if (targetFile) {
  console.log(`📄 Watching YAML file: ${targetFile}`);
} else {
  console.log(`📄 Watching default workspace examples (pass a file path to watch a specific YAML)`);
}

const child = spawn(viteBin, viteArgs, {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(targetFile ? { NETVIZ_FILE: targetFile } : {}),
  },
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
