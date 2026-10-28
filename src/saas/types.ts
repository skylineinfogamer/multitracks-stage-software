import type { BusGroup, OutputBus, Setlist, TrackKind } from '../types';

export type UserRole = 'admin' | 'user';

export type UserApprovalStatus = 'pending' | 'active' | 'rejected';

export type SubscriptionPlanId = 'monthly' | 'annual' | 'church_vip' | 'admin_vip';

export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'trialing' | 'unpaid';

export type PaymentProvider = 'infinitepay' | 'manual';

export interface UserSubscription {
  planId: SubscriptionPlanId;
  planName: string;
  status: SubscriptionStatus;
  provider: PaymentProvider;
  currentPeriodEnd: string; // ISO 8601 date
  checkoutUrl?: string;
  cancelAtPeriodEnd?: boolean;
  priceBrl?: number;
  billingCycle?: 'monthly' | 'annual' | 'lifetime';
  lastPaymentDate?: string;
}

export interface PlanDetails {
  id: SubscriptionPlanId;
  name: string;
  priceBrl: number;
  interval: 'monthly' | 'annual' | 'lifetime';
  description: string;
  features: string[];
  badge?: string;
}

export interface PaymentGatewayConfig {
  activeProvider: 'infinitepay';
  // InfinitePay configuration (Único Gateway Oficial)
  infinitepayHandle?: string;
  infinitepayApiKey?: string;
  infinitepayWebhookSecret?: string;
  infinitepayMonthlyCheckoutUrl?: string;
  infinitepayAnnualCheckoutUrl?: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserApprovalStatus;
  churchName?: string;
  avatarUrl?: string;
  createdAt: string;
  subscription?: UserSubscription;
}

export interface AuthSession {
  user: User;
  token: string;
  expiresAt: string;
}

export interface CatalogStem {
  id: string;
  name: string;
  fileName: string;
  downloadUrl?: string;
  fileId?: string;
  fileSize?: number;
  kind: TrackKind;
  bus: BusGroup;
  output: OutputBus;
  isCombinedStereoSplit?: boolean;
  splitChannel?: 'left' | 'right';
}

export interface CatalogSong {
  id: string;
  title: string;
  artist: string;
  bpm: number;
  key: string;
  beatsPerBar: number;
  durationSec: number;
  cloudFolderId?: string;
  zipFileId?: string;
  zipDownloadUrl?: string;
  zipFileSize?: number;
  provider: 'gdrive' | 'onedrive';
  stems: CatalogStem[];
  tags?: string[];
  addedAt: string;
}

export interface GoogleServiceAccountKey {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri?: string;
  token_uri: string;
  auth_provider_x509_cert_url?: string;
  client_x509_cert_url?: string;
  universe_domain?: string;
}

export interface MasterCloudConfig {
  provider: 'gdrive' | 'onedrive';
  masterToken: string;
  rootFolderId: string;
  rootFolderName: string;
  serviceAccount?: GoogleServiceAccountKey | null;
  lastSyncTime?: string;
  totalSyncedSongs: number;
  adminWhatsAppNumber?: string;
}

export interface SongRequestPayload {
  title: string;
  artist: string;
  key?: string;
  referenceUrl?: string;
  urgencyDate?: string;
  notes?: string;
  userName?: string;
  userEmail?: string;
  churchName?: string;
}

export interface UserCustomization {
  pitchOffset?: number;
  pitchCents?: number;
  bpm?: number;
  trackMix?: Record<string, { volume: number; mute: boolean; solo: boolean; pan: number }>;
}

export interface UserProfileSync {
  userId: string;
  setlists: Setlist[];
  songCustomizations: Record<string, UserCustomization>;
  updatedAt: string;
}

export interface DownloadProgress {
  statusText: string;
  percent: number;
  currentTrackName?: string;
  isError?: boolean;
}
