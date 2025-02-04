export interface NPMHost {
  id: number;
  domain_names: string | string[];
  forward_host: string;
  forward_port: number;
  created_on: string;
  modified_on: string;
}

export interface DNSRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
}

export interface CloudflareZone {
  id: string;
  name: string;
}

export interface CloudflareConfig {
  apiToken: string;
  email: string;
}

export interface NPMConfig {
  apiUrl: string;
  email: string;
  password: string;
}

export interface Config {
  cloudflare: CloudflareConfig;
  npm: NPMConfig;
  checkInterval: number;
  logLevel: string;
  autoCreateRootRecords: boolean;
}

export interface NPMTokenResponse {
  token: string;
}

export interface CloudflareResponse<T> {
  result: T;
  success: boolean;
  errors: any[];
  messages: any[];
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface PublicIPResponse {
  ip: string;
}