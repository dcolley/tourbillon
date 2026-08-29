import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { CompanySelectScreen } from '../screens/CompanySelectScreen';
import { AgentsScreen } from '../screens/AgentsScreen';
import { IssuesScreen } from '../screens/IssuesScreen';

export type RootStackParamList = {
  CompanySelect: undefined;
  Agents: { companyId: string; companyName: string };
  Issues: { companyId: string; companyName: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName="CompanySelect"
        screenOptions={{
          headerStyle: {
            backgroundColor: '#000',
          },
          headerTintColor: '#fff',
          headerTitleStyle: {
            fontWeight: '600',
          },
        }}
      >
        <Stack.Screen
          name="CompanySelect"
          component={CompanySelectScreen}
          options={{ title: 'Select Company' }}
        />
        <Stack.Screen
          name="Agents"
          component={AgentsScreen}
          options={({ route }) => ({ title: route.params.companyName })}
        />
        <Stack.Screen
          name="Issues"
          component={IssuesScreen}
          options={{ title: 'Issues & Inbox' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
