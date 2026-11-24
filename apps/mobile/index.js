/**
 * React Native entry point.
 *
 * RTL is forced on at startup rather than inferred: Arabic is the primary
 * locale (FT-07 §1/§7), and layout direction must be decided before the first
 * render or the capture overlay mirrors mid-session.
 */
import { AppRegistry, I18nManager } from 'react-native';

import { name as appName } from './app.json';
import App from './src/App';

I18nManager.allowRTL(true);

AppRegistry.registerComponent(appName, () => App);
