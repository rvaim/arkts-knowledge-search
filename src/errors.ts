export class KnowledgeError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, cause?: Error) {
    super(message, cause ? { cause } : undefined);
    this.name = 'KnowledgeError';
    this.code = code;
  }
}

export type ThrownValue =
  | object
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;

export function errorMessage(error: ThrownValue): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
