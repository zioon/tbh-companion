// Shared ES3 constants — imported by both the node:crypto implementation
// (`es3.ts`) and the WebCrypto implementation (`es3Web.ts`) so the password and
// error type stay single-sourced across desktop and web builds.

// Default ES3 password baked into TBH builds. Not secret (published on the
// community Save Inspector). Can change in a game update -> update config.
export const DEFAULT_PASSWORD = "emuMqG3bLYJ938ZDCfieWJ";

export class Es3Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Es3Error";
  }
}
