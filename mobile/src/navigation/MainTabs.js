import React, { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
// JS stack (not native-stack): react-native-screens' native ScreenStack renders
// blank on some Android OEMs (e.g. realme/ColorOS). The JS stack renders with
// standard views and works reliably.
import { createStackNavigator } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';

import { colors } from '../theme';
import { useBadges } from '../store/badges';

import DashboardScreen from '../screens/DashboardScreen';
import CalendarScreen from '../screens/CalendarScreen';
import ChatListScreen from '../screens/ChatListScreen';
import ConversationScreen from '../screens/ConversationScreen';
import NewChatScreen from '../screens/NewChatScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import ProfileScreen from '../screens/ProfileScreen';
import LeaveScreen from '../screens/LeaveScreen';
import AttendanceScreen from '../screens/AttendanceScreen';
import PayslipsScreen from '../screens/PayslipsScreen';
import MenuScreen from '../screens/MenuScreen';
import SearchScreen from '../screens/SearchScreen';
import HowToUseScreen from '../screens/HowToUseScreen';
import AnnouncementsScreen from '../screens/AnnouncementsScreen';
import TasksScreen from '../screens/TasksScreen';
import ExpensesScreen from '../screens/ExpensesScreen';
import DocumentsScreen from '../screens/DocumentsScreen';
import GoalsScreen from '../screens/GoalsScreen';
import ReviewsScreen from '../screens/ReviewsScreen';
import LearningScreen from '../screens/LearningScreen';
import CoursePlayerScreen from '../screens/CoursePlayerScreen';
import AssetsScreen from '../screens/AssetsScreen';
import TravelScreen from '../screens/TravelScreen';
import SurveysScreen from '../screens/SurveysScreen';
import LoansScreen from '../screens/LoansScreen';
import RegularizationScreen from '../screens/RegularizationScreen';
import RosterScreen from '../screens/RosterScreen';
import OnboardingScreen from '../screens/OnboardingScreen';
import ComplaintsScreen from '../screens/ComplaintsScreen';
import ChangeRequestScreen from '../screens/ChangeRequestScreen';
import DeclarationScreen from '../screens/DeclarationScreen';
import ResignationScreen from '../screens/ResignationScreen';
import MyInterviewsScreen from '../screens/MyInterviewsScreen';
import SettingsScreen from '../screens/SettingsScreen';
import PrivacyScreen from '../screens/PrivacyScreen';
import AdminHubScreen from '../screens/admin/AdminHubScreen';
import ApprovalsScreen from '../screens/admin/ApprovalsScreen';
import TeamScreen from '../screens/admin/TeamScreen';
import TodayAttendanceScreen from '../screens/admin/TodayAttendanceScreen';
import DirectoryScreen from '../screens/admin/DirectoryScreen';
import EmployeeDetailScreen from '../screens/admin/EmployeeDetailScreen';
import AddEmployeeScreen from '../screens/admin/AddEmployeeScreen';
import WorkLocationsScreen from '../screens/admin/WorkLocationsScreen';
import PayrollScreen from '../screens/admin/PayrollScreen';
import RnrScreen from '../screens/admin/RnrScreen';
import RecruitmentScreen from '../screens/admin/RecruitmentScreen';
import CandidateDetailScreen from '../screens/admin/CandidateDetailScreen';
import AttendanceMonthScreen from '../screens/admin/AttendanceMonthScreen';

const Tab = createBottomTabNavigator();
const HomeStackNav = createStackNavigator();
const ChatStackNav = createStackNavigator();
const ProfileStackNav = createStackNavigator();

const stackOpts = {
  headerStyle: { backgroundColor: colors.surface, elevation: 0, shadowOpacity: 0 },
  headerTitleStyle: { fontWeight: '700', color: colors.text },
  headerTintColor: colors.primary,
  cardStyle: { backgroundColor: colors.bg },
};

function HomeStack() {
  return (
    <HomeStackNav.Navigator screenOptions={stackOpts}>
      <HomeStackNav.Screen name="Dashboard" component={DashboardScreen} options={{ headerShown: false }} />
      <HomeStackNav.Screen name="Leave" component={LeaveScreen} options={{ title: 'Leave' }} />
      <HomeStackNav.Screen name="Attendance" component={AttendanceScreen} options={{ title: 'Attendance' }} />
      <HomeStackNav.Screen name="Payslips" component={PayslipsScreen} options={{ title: 'Payslips' }} />
      <HomeStackNav.Screen name="Menu" component={MenuScreen} options={{ title: 'All modules' }} />
      <HomeStackNav.Screen name="Search" component={SearchScreen} options={{ title: 'Search' }} />
      <HomeStackNav.Screen name="HowToUse" component={HowToUseScreen} options={{ title: 'How to Use' }} />
      <HomeStackNav.Screen name="Announcements" component={AnnouncementsScreen} options={{ title: 'Announcements' }} />
      <HomeStackNav.Screen name="Tasks" component={TasksScreen} options={{ title: 'My Tasks' }} />
      <HomeStackNav.Screen name="Expenses" component={ExpensesScreen} options={{ title: 'Expenses' }} />
      <HomeStackNav.Screen name="Documents" component={DocumentsScreen} options={{ title: 'Documents' }} />
      <HomeStackNav.Screen name="Goals" component={GoalsScreen} options={{ title: 'My Goals' }} />
      <HomeStackNav.Screen name="Reviews" component={ReviewsScreen} options={{ title: 'Performance Reviews' }} />
      <HomeStackNav.Screen name="Learning" component={LearningScreen} options={{ title: 'Learning' }} />
      <HomeStackNav.Screen name="CoursePlayer" component={CoursePlayerScreen} options={{ title: 'Course' }} />
      <HomeStackNav.Screen name="Assets" component={AssetsScreen} options={{ title: 'My Assets' }} />
      <HomeStackNav.Screen name="Travel" component={TravelScreen} options={{ title: 'Travel' }} />
      <HomeStackNav.Screen name="Surveys" component={SurveysScreen} options={{ title: 'Surveys' }} />
      <HomeStackNav.Screen name="Loans" component={LoansScreen} options={{ title: 'Loans & Advances' }} />
      <HomeStackNav.Screen name="Regularization" component={RegularizationScreen} options={{ title: 'Regularization' }} />
      <HomeStackNav.Screen name="Roster" component={RosterScreen} options={{ title: 'My Roster' }} />
      <HomeStackNav.Screen name="Onboarding" component={OnboardingScreen} options={{ title: 'Onboarding' }} />
      <HomeStackNav.Screen name="Complaints" component={ComplaintsScreen} options={{ title: 'Complaints' }} />
      <HomeStackNav.Screen name="ChangeRequest" component={ChangeRequestScreen} options={{ title: 'Change Requests' }} />
      <HomeStackNav.Screen name="Declaration" component={DeclarationScreen} options={{ title: 'Investment Declaration' }} />
      <HomeStackNav.Screen name="Resignation" component={ResignationScreen} options={{ title: 'Resignation' }} />
      <HomeStackNav.Screen name="MyInterviews" component={MyInterviewsScreen} options={{ title: 'My Interviews' }} />
      {/* Admin / manager surface (screens self-gate by role) */}
      <HomeStackNav.Screen name="AdminHub" component={AdminHubScreen} options={{ title: 'Admin Console' }} />
      <HomeStackNav.Screen name="Approvals" component={ApprovalsScreen} options={{ title: 'Approvals' }} />
      <HomeStackNav.Screen name="Team" component={TeamScreen} options={{ title: 'My Team' }} />
      <HomeStackNav.Screen name="TodayAttendance" component={TodayAttendanceScreen} options={{ title: "Today's Attendance" }} />
      <HomeStackNav.Screen name="Directory" component={DirectoryScreen} options={{ title: 'Directory' }} />
      <HomeStackNav.Screen name="EmployeeDetail" component={EmployeeDetailScreen} options={({ route }) => ({ title: route.params?.title || 'Employee' })} />
      <HomeStackNav.Screen name="AddEmployee" component={AddEmployeeScreen} options={{ title: 'Add Employee' }} />
      <HomeStackNav.Screen name="WorkLocations" component={WorkLocationsScreen} options={{ title: 'Work Locations' }} />
      <HomeStackNav.Screen name="PayrollAdmin" component={PayrollScreen} options={{ title: 'Payroll' }} />
      <HomeStackNav.Screen name="RnrAdmin" component={RnrScreen} options={{ title: 'Rewards & Recognition' }} />
      <HomeStackNav.Screen name="Recruitment" component={RecruitmentScreen} options={{ title: 'Recruitment' }} />
      <HomeStackNav.Screen name="CandidateDetail" component={CandidateDetailScreen} options={({ route }) => ({ title: route.params?.name || 'Candidate' })} />
      <HomeStackNav.Screen name="AttendanceMonth" component={AttendanceMonthScreen} options={{ title: 'Monthly Attendance' }} />
    </HomeStackNav.Navigator>
  );
}

function ProfileStack() {
  return (
    <ProfileStackNav.Navigator screenOptions={stackOpts}>
      <ProfileStackNav.Screen name="ProfileHome" component={ProfileScreen} options={{ headerShown: false }} />
      <ProfileStackNav.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
      <ProfileStackNav.Screen name="Privacy" component={PrivacyScreen} options={{ title: 'Privacy Policy' }} />
    </ProfileStackNav.Navigator>
  );
}

function ChatStack() {
  return (
    <ChatStackNav.Navigator screenOptions={stackOpts}>
      <ChatStackNav.Screen name="ChatList" component={ChatListScreen} options={{ title: 'Messages' }} />
      <ChatStackNav.Screen
        name="Conversation"
        component={ConversationScreen}
        options={({ route }) => ({ title: route.params?.title || 'Chat' })}
      />
      <ChatStackNav.Screen name="NewChat" component={NewChatScreen} options={{ title: 'New conversation' }} />
    </ChatStackNav.Navigator>
  );
}

const ICONS = {
  Home: 'home',
  Calendar: 'calendar',
  Chat: 'chatbubbles',
  Alerts: 'notifications',
  Profile: 'person',
};

export default function MainTabs() {
  const { notifications, chat, refresh } = useBadges();
  const appState = useRef(AppState.currentState);

  // Poll unread badges while foregrounded.
  useEffect(() => {
    refresh();
    const interval = setInterval(() => {
      if (AppState.currentState === 'active') refresh();
    }, 30000);
    const sub = AppState.addEventListener('change', (next) => {
      if (appState.current.match(/inactive|background/) && next === 'active') refresh();
      appState.current = next;
    });
    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [refresh]);

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          height: 62,
          paddingBottom: 8,
          paddingTop: 6,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarIcon: ({ color, size, focused }) => (
          <Ionicons name={focused ? ICONS[route.name] : `${ICONS[route.name]}-outline`} size={size} color={color} />
        ),
      })}
    >
      <Tab.Screen name="Home" component={HomeStack} />
      <Tab.Screen name="Calendar" component={CalendarScreen} />
      <Tab.Screen
        name="Chat"
        component={ChatStack}
        options={{ tabBarBadge: chat || undefined, tabBarBadgeStyle: { backgroundColor: colors.danger } }}
      />
      <Tab.Screen
        name="Alerts"
        component={NotificationsScreen}
        options={{ tabBarBadge: notifications || undefined, tabBarBadgeStyle: { backgroundColor: colors.danger } }}
      />
      <Tab.Screen name="Profile" component={ProfileStack} />
    </Tab.Navigator>
  );
}
