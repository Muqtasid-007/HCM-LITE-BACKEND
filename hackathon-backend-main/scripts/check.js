import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
function files(path){return readdirSync(path,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(`${path}/${e.name}`):e.name.endsWith('.js')?[`${path}/${e.name}`]:[]);}
for(const path of ['server.js',...files('src'),...files('tests'),...files('scripts')]){const result=spawnSync(process.execPath,['--check',path],{stdio:'inherit'});if(result.status)process.exit(result.status);}
console.log('All JavaScript syntax checks passed.');
