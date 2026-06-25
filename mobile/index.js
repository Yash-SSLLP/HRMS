import 'react-native-gesture-handler';
// Disable react-native-screens' native screen containers. On some Android OEMs
// (e.g. realme/ColorOS) the native ScreenStack fails to attach stack-screen
// content, leaving every stacked screen blank. With this off, the JS stack and
// tabs render with plain views — reliably everywhere.
import { enableScreens } from 'react-native-screens';
enableScreens(false);

import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
