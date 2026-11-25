import { AssignmentReport } from "../types";
import { registerGeneratedOutput } from "../utils/GeneratedOutputGuard";

export async function writeAssignmentReport(
  writeFile: (target: any, content: Uint8Array) => Thenable<void> | Promise<void>,
  target: any,
  report: AssignmentReport,
): Promise<void> {
  const registration = registerGeneratedOutput(target);
  try {
    await writeFile(
      target,
      Buffer.from(JSON.stringify(report, null, 2), "utf8"),
    );
  } catch (error) {
    registration.rollback();
    throw error;
  }
  registration.complete();
}
