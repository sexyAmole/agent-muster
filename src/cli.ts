import { main } from './cli/index.js';

main().catch(error => { console.error(error.message); process.exitCode = 1; });
