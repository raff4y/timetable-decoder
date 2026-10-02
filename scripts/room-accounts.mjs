// Manage Free Room Finder accounts. The Room Finder has no sign-up: these are
// the only people who can use it (its login is separate from the timetable tool's).
//
//   npm run rooms:accounts -- list
//   npm run rooms:accounts -- add <username> [--name "Full Name"]
//   npm run rooms:accounts -- reset-password <username>
//   npm run rooms:accounts -- disable <username>
//   npm run rooms:accounts -- enable <username>
//   npm run rooms:accounts -- remove <username>
//
// `add` and `reset-password` print a generated password once; only its hash is
// stored. Hand it over privately; the person can change it after signing in.
// Passwords are never taken on the command line, so they don't end up in shell
// history. Admins can do the same through /api/admin/room-accounts.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './load-env.mjs';

const USAGE = `Usage:
  npm run rooms:accounts -- list
  npm run rooms:accounts -- add <username> [--name "Full Name"]
  npm run rooms:accounts -- reset-password <username>
  npm run rooms:accounts -- disable <username>
  npm run rooms:accounts -- enable <username>
  npm run rooms:accounts -- remove <username>`;

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') flags.name = argv[++i] ?? '';
    else if (a.startsWith('--name=')) flags.name = a.slice('--name='.length);
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else positional.push(a);
  }
  const [command, username] = positional;
  return { command, username, name: flags.name };
}

function fmtDate(iso) {
  return iso ? iso.slice(0, 16).replace('T', ' ') : 'never';
}

/** Runs one command; `out` receives the lines to print. Exported for tests. */
export async function runCommand({ command, username, name }, out = console.log) {
  const { accountDto, createAccount, deleteAccount, listAccounts, updateAccount } = await import('../server/rooms/accounts.js');
  const needsUser = ['add', 'reset-password', 'disable', 'enable', 'remove'];
  if (needsUser.includes(command) && !username) throw new Error(`${command} needs a username.\n\n${USAGE}`);

  switch (command) {
    case 'list': {
      const rows = (await listAccounts()).map(accountDto);
      if (!rows.length) return out('No Room Finder accounts yet. Add one with: npm run rooms:accounts -- add <username>');
      for (const a of rows) {
        out(`${a.username.padEnd(28)} ${a.status.padEnd(9)} last sign-in ${fmtDate(a.lastLoginAt)}${a.displayName ? `  (${a.displayName})` : ''}`);
      }
      return;
    }
    case 'add': {
      const { account, temporaryPassword } = await createAccount({ username, displayName: name });
      out(`Created Room Finder account "${account.username}".`);
      out(`Password: ${temporaryPassword}`);
      out('It is shown only now. They sign in at /rooms/login.html and can change it from the Room Finder.');
      return;
    }
    case 'reset-password': {
      const { account, temporaryPassword } = await updateAccount(username, { resetPassword: true });
      out(`New password for "${account.username}": ${temporaryPassword}`);
      out('It is shown only now. Their existing sessions were signed out.');
      return;
    }
    case 'disable':
    case 'enable': {
      const { account } = await updateAccount(username, { status: command === 'disable' ? 'disabled' : 'active' });
      out(`"${account.username}" is now ${account.status}.${account.status === 'disabled' ? ' Their sessions were signed out.' : ''}`);
      return;
    }
    case 'remove': {
      const account = await deleteAccount(username);
      out(`Removed Room Finder account "${account.username}".`);
      return;
    }
    default:
      throw new Error(command ? `Unknown command "${command}".\n\n${USAGE}` : USAGE);
  }
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const { closeDb } = await import('../server/db.js');
  try {
    await runCommand(args);
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
