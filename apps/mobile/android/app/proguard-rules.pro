# React Native
-keep class com.facebook.react.** { *; }
-keep class com.facebook.hermes.** { *; }

# The native capture module is reached by name from JavaScript.
-keep class ai.facetype.capture.** { *; }
# The client camera module and view (docs/client-native-interface.md).
-keep class ai.facetype.client.** { *; }

# ARCore
-keep class com.google.ar.core.** { *; }
