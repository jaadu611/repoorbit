import path from "path";
import os from "os";

export const CONTEXT_DIR_PATH = path.join(os.tmpdir(), "repoorbit_sandboxes", ".metadata");
export const MAX_LINES_PER_FILE = 1000;
export const MAX_FILES_PER_TURN = 15;
export const MAX_ROUNDS = 10;
export const AGENT_QUESTION_LIMIT = 10;
export const ARCHITECT_QUESTION_LIMIT = 30;
