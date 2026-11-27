#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const javascriptFiles = [
  'server.js',
  'api/index.js',
  'api/[...slug].js',
  'db/api.js',
  'db/pool.js',
  'db/migrate.js'
];
const jsonFiles = ['package.json', 'vercel.json'];
const htmlFiles = ['index.html', 'admin.html', 'vender.html'];
const errors = [];

function checkJavaScript(label, source) {
  try {
    new vm.Script(source, { filename: label });
    console.log('PASS JavaScript:', label);
  } catch (error) {
    errors.push(label + ': ' + error.message);
    console.error('FAIL JavaScript:', label, error.message);
  }
}

for (const relative of javascriptFiles) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    errors.push(relative + ': file is missing');
    console.error('FAIL missing:', relative);
    continue;
  }
  checkJavaScript(relative, fs.readFileSync(file, 'utf8'));
}

for (const relative of jsonFiles) {
  const file = path.join(root, relative);
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log('PASS JSON:', relative);
  } catch (error) {
    errors.push(relative + ': ' + error.message);
    console.error('FAIL JSON:', relative, error.message);
  }
}

for (const relative of htmlFiles) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) continue;
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  scripts.forEach((match, index) => {
    if (match[1].trim()) checkJavaScript(relative + ' inline script ' + (index + 1), match[1]);
  });
}

if (errors.length) {
  console.error('\nValidation failed with ' + errors.length + ' error(s).');
  process.exit(1);
}
console.log('\nCourseCorrect validation passed.');
