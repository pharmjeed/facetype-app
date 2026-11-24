/**
 * Babel for React Native.
 *
 * Without this file `react-native bundle` fails outright, so the app could
 * compile natively and still have no JavaScript to run (audit: bundling).
 *
 * `babel/inlineBuildEnv.js` turns the allowlisted FACETYPE_* variables into
 * string literals. React Native's `process` shim carries only NODE_ENV, so
 * without it the API base URL read back as `undefined` on every device.
 */
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [require.resolve('./babel/inlineBuildEnv.js')],
};
