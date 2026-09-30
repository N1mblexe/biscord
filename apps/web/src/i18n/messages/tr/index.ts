import type { Messages } from '../en';
import { a11y } from './a11y';
import { admin } from './admin';
import { auth } from './auth';
import { chat } from './chat';
import { common } from './common';
import { errors } from './errors';
import { settings } from './settings';
import { voice } from './voice';

/** The Turkish dictionary. Typed against English, so a missing or extra key is a type error. */
export const tr: Messages = { common, auth, settings, admin, chat, voice, errors, a11y };
