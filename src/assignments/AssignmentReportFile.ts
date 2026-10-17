import { AssignmentReport } from "../types";

export async function writeAssignmentReport(
  writeFile: (target: any, content: Uint8Array) => Thenable<void> | Promise<void>,
  target: any,
  report: AssignmentReport,
): Promise<void> {
  await writeFile(
    target,
    Buffer.from(JSON.stringify(report, null, 2), "utf8"),
  );
}