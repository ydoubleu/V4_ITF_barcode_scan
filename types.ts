export type RecordType = 'SCAN' | 'INFO';

export interface ScannedRecord {
  id: string;
  type: RecordType;
  code: string;       // For INFO type, this holds the message text
  format?: string;
  timestamp: number;
}

export type FeedbackState = {
  type: 'success' | 'error';
  message: string;
} | null;
