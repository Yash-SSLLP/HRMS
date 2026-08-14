// navigation/MainTabs.js — the signed-in app shell.
// A bottom-tab navigator: Home, Calendar, Chat, Alerts, Profile, plus a raised
// centre Search button sitting between Calendar and Chat/Alerts (see
// SearchTabButton — it jumps into the Home stack rather than being a tab).
// Home, Chat and Profile each wrap a JS stack navigator (createStackNavigator,
// not native-stack — see note below) holding all the module screens; Home's
// stack also carries the admin/manager screens, which self-gate by role. Chat
// and Alerts tabs show live unread badges from the badges store, refreshed on a
// 30s foreground poll.
import React, { useEffect, useRef } from 'react';
import { AppState, View, StyleSheet, TouchableOpacity } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
// JS stack (not native-stack): react-native-screens' native ScreenStack renders
// blank on some Android OEMs (e.g. realme/ColorOS). The JS stack renders with
// standard views and works reliably.
import { createStackNavigator } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';

import { colors, shadow } from '../theme';
import api from '../api/client';
import { useAuth } from '../store/auth';
import { useBadges } from '../store/badges';
import { autoCheckForUpdate } from '../services/appUpdate';

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
import CashbookScreen from '../screens/CashbookScreen';
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
import MyApprovalsScreen from '../screens/MyApprovalsScreen';
import OrgChartScreen from '../screens/OrgChartScreen';
import SettingsScreen from '../screens/SettingsScreen';
import PrivacyScreen from '../screens/PrivacyScreen';
import AdminHubScreen from '../screens/admin/AdminHubScreen';
import ApprovalsScreen from '../screens/admin/ApprovalsScreen';
import TeamScreen from '../screens/admin/TeamScreen';
import TodayAttendanceScreen from '../screens/admin/TodayAttendanceScreen';
import DirectoryScreen from '../screens/admin/DirectoryScreen';
import EmployeeDetailScreen from '../screens/admin/EmployeeDetailScreen';
import AccountDetailScreen from '../screens/admin/AccountDetailScreen';
import AddEmployeeScreen from '../screens/admin/AddEmployeeScreen';
import WorkLocationsScreen from '../screens/admin/WorkLocationsScreen';
import PushNotificationScreen from '../screens/admin/PushNotificationScreen';
import BrandingScreen from '../screens/admin/BrandingScreen';
import PayrollScreen from '../screens/admin/PayrollScreen';
import RnrScreen from '../screens/admin/RnrScreen';
import CalendarImportScreen from '../screens/admin/CalendarImportScreen';
import RecruitmentScreen from '../screens/admin/RecruitmentScreen';
import CandidateDetailScreen from '../screens/admin/CandidateDetailScreen';
import AttendanceMonthScreen from '../screens/admin/AttendanceMonthScreen';
import PunchMapScreen from '../screens/admin/PunchMapScreen';

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

/** Home-tab stack: dashboard plus every employee module and the role-gated
 *  admin/manager screens. */
function HomeStack() {
  return (
    <HomeStackNav.Navigator screenOptions={stackOpts}>
      <HomeStackNav.Screen name="Dashboard" component={DashboardScreen} options={{ headerShown: false }} />
      <HomeStackNav.Screen name="Leave" component={LeaveScreen} options={{ title: 'Leave' }} />
      <HomeStackNav.Screen name="Attendance" component={AttendanceScreen} options={{ title: 'Attendance' }} />
      <HomeStackNav.Screen name="Payslips" component={PayslipsScreen} options={{ title: 'Payslips' }} />
      <HomeStackNav.Screen name="Menu" component={MenuScreen} options={{ title: 'All modules' }} />
      <HomeStackNav.Screen name="Search" component={SearchScreen} options={{ title: 'Search' }} />
      <HomeStackNav.Screen name="HowToUse" component={HowToUseScreen} options={{ title: 'Help' }} />
      <HomeStackNav.Screen name="Announcements" component={AnnouncementsScreen} options={{ title: 'Announcements' }} />
      <HomeStackNav.Screen name="Tasks" component={TasksScreen} options={{ title: 'My Tasks' }} />
      <HomeStackNav.Screen name="Expenses" component={ExpensesScreen} options={{ title: 'Expenses' }} />
      <HomeStackNav.Screen name="Cashbook" component={CashbookScreen} options={{ title: 'Cash Vouchers' }} />
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
      {/* Reporting-chain approver inbox — every role, since any employee can be
          someone's reporting manager in the org chart. */}
      <HomeStackNav.Screen name="MyApprovals" component={MyApprovalsScreen} options={{ title: 'My Approvals' }} />
      <HomeStackNav.Screen name="OrgChart" component={OrgChartScreen} options={{ title: 'Org Chart' }} />
      {/* Admin / manager surface (screens self-gate by role) */}
      <HomeStackNav.Screen name="AdminHub" component={AdminHubScreen} options={{ title: 'Admin Console' }} />
      <HomeStackNav.Screen name="Approvals" component={ApprovalsScreen} options={{ title: 'Approvals' }} />
      <HomeStackNav.Screen name="Team" component={TeamScreen} options={{ title: 'My Team' }} />
      <HomeStackNav.Screen name="TodayAttendance" component={TodayAttendanceScreen} options={{ title: "Today's Attendance" }} />
      <HomeStackNav.Screen name="Directory" component={DirectoryScreen} options={{ title: 'Directory' }} />
      <HomeStackNav.Screen name="EmployeeDetail" component={EmployeeDetailScreen} options={({ route }) => ({ title: route.params?.title || 'Employee' })} />
      {/* CEO/MD/SuperAdmin have no employee profile, so they get an account page
          instead of EmployeeDetail (reached from Search + Directory). */}
      <HomeStackNav.Screen name="AccountDetail" component={AccountDetailScreen} options={({ route }) => ({ title: route.params?.title || 'Account' })} />
      <HomeStackNav.Screen name="AddEmployee" component={AddEmployeeScreen} options={{ title: 'Add Employee' }} />
      <HomeStackNav.Screen name="WorkLocations" component={WorkLocationsScreen} options={{ title: 'Work Locations' }} />
      {/* SuperAdmin-only in practice; the screen and the server both gate it. */}
      <HomeStackNav.Screen name="PushNotification" component={PushNotificationScreen} options={{ title: 'Push Notification' }} />
      <HomeStackNav.Screen name="Branding" component={BrandingScreen} options={{ title: 'Logo & Signatures' }} />
      <HomeStackNav.Screen name="PayrollAdmin" component={PayrollScreen} options={{ title: 'Payroll' }} />
      <HomeStackNav.Screen name="RnrAdmin" component={RnrScreen} options={{ title: 'Rewards & Recognition' }} />
      <HomeStackNav.Screen name="CalendarImport" component={CalendarImportScreen} options={{ title: 'Calendar Upload' }} />
      <HomeStackNav.Screen name="Recruitment" component={RecruitmentScreen} options={{ title: 'Recruitment' }} />
      <HomeStackNav.Screen name="CandidateDetail" component={CandidateDetailScreen} options={({ route }) => ({ title: route.params?.name || 'Candidate' })} />
      <HomeStackNav.Screen name="AttendanceMonth" component={AttendanceMonthScreen} options={{ title: 'Monthly Attendance' }} />
      <HomeStackNav.Screen name="PunchMap" component={PunchMapScreen} options={{ title: 'Punch Location Map' }} />
    </HomeStackNav.Navigator>
  );
}

/** Profile-tab stack: profile, settings and privacy policy. */
function ProfileStack() {
  return (
    <ProfileStackNav.Navigator screenOptions={stackOpts}>
      <ProfileStackNav.Screen name="ProfileHome" component={ProfileScreen} options={{ headerShown: false }} />
      <ProfileStackNav.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
      <ProfileStackNav.Screen name="Privacy" component={PrivacyScreen} options={{ title: 'Privacy Policy' }} />
    </ProfileStackNav.Navigator>
  );
}

/** Chat-tab stack: conversation list, a single conversation, and new-chat. */
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
  SearchTab: 'search',
  Chat: 'chatbubbles',
  Alerts: 'notifications',
  Profile: 'person',
};

/**
 * The raised centre action in the tab bar — Search, sitting between Calendar and
 * the Alerts side of the bar. Replaces the whole tab button (icon + label), so
 * it carries no label; the gold disc IS the affordance.
 *
 * Deliberately built WITHOUT `elevation`. A View combining elevation + border
 * radius renders blank (children vanish) on some Adreno/ColorOS devices — the
 * same class of bug that took out the Card shadow — so depth comes from
 * `shadow.floating` (a no-op on Android by design) plus a surface-coloured ring,
 * which reads as a cut-out in the bar. Ink is `colors.onPrimary`: white on the
 * brand gold is only ~2.4:1.
 */
function SearchTabButton({ onPress, onLongPress }) {
  return (
    <TouchableOpacity
      style={tabStyles.centreSlot}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel="Search"
    >
      <View style={[tabStyles.centreDisc, shadow.floating]}>
        <Ionicons name="search" size={24} color={colors.onPrimary} />
      </View>
    </TouchableOpacity>
  );
}

const tabStyles = StyleSheet.create({
  centreSlot: { flex: 1, alignItems: 'center', justifyContent: 'flex-start' },
  centreDisc: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    // The ring is the bar's own colour, so the disc reads as lifted out of it.
    borderWidth: 4,
    borderColor: colors.surface,
    // Lift it above the bar's top edge. The bar height below is raised to match
    // so the disc never collides with the labels on either side.
    marginTop: -20,
  },
});

/**
 * Bottom-tab navigator shown once authenticated. Wires the five tabs, their
 * unread badges, and the foreground badge-refresh polling.
 */
export default function MainTabs() {
  const { notifications, chat, refresh } = useBadges();
  const appState = useRef(AppState.currentState);
  const setFeatures = useAuth((s) => s.setFeatures);
  const setUser = useAuth((s) => s.setUser);
  const chatEnabled = useAuth((s) => s.features?.chatEnabled);

  // Sync the org-wide feature switches (e.g. whether chat exists) once on mount,
  // and re-cache the user with them: access grants an admin changes server-side
  // (e.g. a CEO/MD switched into edit mode) would otherwise stay invisible to
  // this app until the next login.
  useEffect(() => {
    api.get('/auth/me')
      .then(({ data }) => {
        if (data?.user) setUser(data.user);
        setFeatures(data?.features);
      })
      .catch(() => {});
    // Silent: it only caches the answer so Settings can show a dot. It never
    // alerts or navigates — an update nobody asked for should not interrupt
    // whatever the app was opened to do. Self-limiting to once a day, and a
    // no-op when the Settings toggle is off.
    autoCheckForUpdate().catch(() => {});
  }, [setUser, setFeatures]);

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
          // 62 → 68 to make room for the raised centre Search disc, which is
          // pulled 20px above the bar's top edge.
          height: 68,
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
      {/* Raised centre action, between Calendar and the Alerts side of the bar.
          Same screen the Dashboard header's search icon opens — that entry point
          still works, this just makes it reachable from anywhere in the app.

          The press is intercepted and routed into the HOME STACK's Search rather
          than switching to this tab, and the component below is never actually
          rendered. That is deliberate: SearchScreen's result rows navigate with
          `nav.navigate('Leave' | 'EmployeeDetail' | …)`, which only resolve
          inside the Home stack, and `nav.getParent()` must be the tab navigator
          for its tab shortcuts. Hosted as a tab in its own right, every one of
          those rows would be a dead tap. */}
      <Tab.Screen
        name="SearchTab"
        component={SearchScreen}
        options={{ tabBarButton: (props) => <SearchTabButton {...props} /> }}
        listeners={({ navigation }) => ({
          tabPress: (e) => {
            e.preventDefault();
            navigation.navigate('Home', { screen: 'Search' });
          },
        })}
      />
      {/* Chat is an org-wide switch a SuperAdmin controls. */}
      {chatEnabled && (
        <Tab.Screen
          name="Chat"
          component={ChatStack}
          options={{ tabBarBadge: chat || undefined, tabBarBadgeStyle: { backgroundColor: colors.danger } }}
        />
      )}
      <Tab.Screen
        name="Alerts"
        component={NotificationsScreen}
        options={{ tabBarBadge: notifications || undefined, tabBarBadgeStyle: { backgroundColor: colors.danger } }}
      />
      <Tab.Screen name="Profile" component={ProfileStack} />
    </Tab.Navigator>
  );
}
