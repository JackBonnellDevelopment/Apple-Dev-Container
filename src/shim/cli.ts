import { dispatch } from './commands';
import { ShimError } from './errors';

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (err) {
    if (err instanceof ShimError) {
      process.stderr.write(err.message.endsWith('\n') ? err.message : `${err.message}\n`);
      return err.exitCode;
    }
    process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
    return 1;
  }
}
