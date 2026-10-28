export class ClientError extends Error {
  constructor(message: string, readonly code = "CLIENT_ERROR") {
    super(message);
    this.name = "ClientError";
  }
}

export class NotLoggedIn extends ClientError {
  constructor(message = "Log in with the login command or provide --cookies <file|browser>.") {
    super(message, "AUTH_REQUIRED");
  }
}

export class UiChanged extends ClientError {
  constructor(message: string) { super(message, "UI_CHANGED"); }
}

export class WriteUncertain extends ClientError {
  constructor(message: string) {
    super(`${message} Inspect the destination before retrying; the action may already have succeeded.`, "WRITE_UNCERTAIN");
  }
}
