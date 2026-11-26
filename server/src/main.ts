/** Entry point: wires everything together and starts listening. */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { recoverInterruptedRuns } from './engine/engine.js';
import { errorMessage } from './errors.js';
import { importFormula } from './http/api.js';
import { buildServer } from './http/server.js';
import { agentMkdir } from './sandbox/agent.js';
import { closeAllForwards, syncForwards } from './sandbox/forwards.js';
import { startAllTriggers, stopAllTriggers } from './triggers/index.js';

/** Workflows defined as code: every formula file in the formulas directory is imported at startup. */
async function importFormulaFiles(): Promise<void> {
  if (!config.formulasDir) return;
  let files: string[] = [];
  try {
    files = readdirSync(config.formulasDir).filter((file) => /\.ya?ml$/.test(file));
  } catch {
    console.warn(`Formulas directory ${config.formulasDir} cannot be read`);
  }
  for (const file of files) {
    try {
      const workflow = await importFormula(readFileSync(path.join(config.formulasDir, file), 'utf8'));
      console.log(`Imported formula ${file} as workflow "${workflow.name}"`);
    } catch (error) {
      console.warn(`Formula ${file} was not imported: ${errorMessage(error)}`);
    }
  }
}

async function main(): Promise<void> {
  await agentMkdir(config.agentHome);
  await agentMkdir(config.workspacesDir);

  recoverInterruptedRuns();
  await importFormulaFiles();
  startAllTriggers();
  await syncForwards();

  const app = await buildServer();
  await app.listen({ host: config.host, port: config.port });
  console.log(`Auto Worker is listening on http://${config.host}:${config.port}`);
  if (config.tokenWasGenerated) {
    console.log(`No AUTOWORKER_TOKEN was set. Sign in with this generated token: ${config.token}`);
  }

  const shutdown = async () => {
    stopAllTriggers();
    await closeAllForwards();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
