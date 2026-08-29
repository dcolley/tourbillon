import { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator } from 'react-native';
import { RootNavigator } from './src/navigation/RootNavigator';
import { apiClient } from './src/api/client';

export default function App() {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    // Initialize API client (load session token)
    apiClient.initialize().finally(() => setIsReady(true));
  }, []);

  if (!isReady) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <>
      <RootNavigator />
      <StatusBar style="light" />
    </>
  );
}
