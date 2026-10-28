import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { ClientError } from "./errors.ts";

export function validateUpload(path: string, target: string): void {
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/.test(target)) throw new ClientError("Upload target must be user/game:channel.", "INVALID_ARGUMENT");
  const entry = statSync(path);
  if (!entry.isFile() && !entry.isDirectory()) throw new ClientError("Upload requires a file or directory.", "INVALID_ARGUMENT");
}

export function uploadFailure(stderr: string, code: number | null, signal: string | null): ClientError {
  if (/verify your account.s email address/i.test(stderr)) return new ClientError("Verify your itch.io account email, then retry the upload.", "EMAIL_VERIFICATION_REQUIRED");
  return new ClientError(`butler did not complete (exit ${code}, signal ${signal}). Inspect the channel before retrying.`, "UPLOAD_FAILED");
}

/** Official butler owns upload authentication, patching, and channel processing. */
export async function upload(path: string, target: string, options: { version?: string; executable?: string } = {}): Promise<unknown> {
  validateUpload(path, target);
  const executable = options.executable || process.env.ITCHIOCLI_BUTLER || "butler";
  const args = ["push", resolve(path), target, ...(options.version ? ["--userversion", options.version] : [])];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["inherit", "pipe", "pipe"], shell: false });
    let diagnostic = "";
    const output = (chunk: Buffer) => { process.stderr.write(chunk); diagnostic = (diagnostic + chunk.toString()).slice(-8192); };
    child.stdout?.on("data", output); child.stderr?.on("data", output);
    child.once("error", () => reject(new ClientError("Cannot launch butler. Install it from https://itch.io/docs/butler/ and run butler login.", "BUTLER_UNAVAILABLE")));
    child.once("close", (code, signal) => code === 0 ? resolve() : reject(uploadFailure(diagnostic, code, signal)));
  });
  return { status: "uploaded", target, version: options.version ?? null };
}
