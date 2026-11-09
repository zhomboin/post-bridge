import { test } from './fixtures';
import { remoteLoginTest } from './remote-login-flow';

test.use({ remoteLoginMethod: 'qr' });
remoteLoginTest('qr');
