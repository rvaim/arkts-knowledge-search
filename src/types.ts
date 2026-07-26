export interface KnowledgeSearchResult {
  question: string;
  answer: string;
  endpoint: string;
  queriedAt: string;
}

export interface KnowledgeStatus {
  authenticated: boolean;
  expiresAt: string | null;
  message: string;
  loginCommand: string;
}
