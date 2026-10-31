import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  verifyEvent,
  getEventHash,
} from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import * as nip44 from 'nostr-tools/nip44';
import * as nip49 from 'nostr-tools/nip49';
import { deflateSync, inflateSync } from 'fflate';

window.MiyuVendor = {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  verifyEvent,
  getEventHash,
  SimplePool,
  nip44,
  nip49,
  deflateSync,
  inflateSync,
};
