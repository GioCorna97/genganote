// Avvia il widget anche da terminali (es. VS Code) che impostano ELECTRON_RUN_AS_NODE=1.
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron'); // path dell'eseguibile
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(__dirname, '..')], { env, detached: true, stdio: 'ignore', windowsHide: false });
child.unref();
console.log('🧠 GengaNote avviato (pid ' + child.pid + ')');
