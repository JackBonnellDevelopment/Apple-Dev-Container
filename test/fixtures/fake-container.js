#!/usr/bin/env node
'use strict';

const fs = require('fs');

const args = process.argv.slice(2);
const log = process.env.CONTAINER_FAKE_LOG;
if (log) {
  fs.appendFileSync(log, `${JSON.stringify(args)}\n`);
}

function read(name) {
  const file = process.env[name];
  if (!file) {
    process.stdout.write('[]');
    return;
  }
  process.stdout.write(fs.readFileSync(file, 'utf8'));
}

const [command, sub] = args;
if (command === 'system' && sub === 'status') {
  process.stdout.write('FIELD               VALUE\nstatus              running\n');
  process.exit(0);
}
if (command === 'system' && sub === 'start') {
  process.exit(0);
}
if (command === 'list') {
  read('CONTAINER_FAKE_LIST');
  process.exit(0);
}
if (command === 'inspect') {
  read('CONTAINER_FAKE_INSPECT');
  process.exit(0);
}
if (command === 'image' && sub === 'inspect') {
  read('CONTAINER_FAKE_IMAGE');
  process.exit(0);
}
if (command === 'image' && sub === 'list') {
  read('CONTAINER_FAKE_IMAGE');
  process.exit(0);
}
if (command === 'volume' && (sub === 'list' || sub === 'ls')) {
  read('CONTAINER_FAKE_VOLUMES');
  process.exit(0);
}
if (command === 'volume' && sub === 'inspect') {
  read('CONTAINER_FAKE_VOLUME');
  process.exit(0);
}

process.exit(0);
