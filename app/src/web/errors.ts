// Web build: turn a thrown error from the save-load pipeline into a message the
// user can act on. The desktop app shows these via its own error surfaces; in
// the browser the user has just picked a file by hand, so the message must say
// what was wrong with *that* file.

import { Es3Error } from "../core/es3Constants";

const WRONG_PASSWORD_HINT =
  "This file isn't a Task Bar Hero save, or the save password changed in a game update.";

export function classifySaveFileError(err: unknown): string {
  if (err instanceof Es3Error) {
    const message = err.message;
    if (message.includes("too small")) {
      return "That file is too small to be a save. Pick the .es3 file from the game's save folder.";
    }
    if (message.includes("mid-write") || message.includes("block size")) {
      return "The save looks incomplete — the game may have been writing it. Wait a moment and try again.";
    }
    return `${message}\n\n${WRONG_PASSWORD_HINT}`;
  }

  if (err instanceof SyntaxError) {
    return "The save decrypted, but its contents weren't readable JSON. It may be from an unsupported game version.";
  }

  if (err instanceof Error) return err.message;
  return "Could not read that file.";
}
