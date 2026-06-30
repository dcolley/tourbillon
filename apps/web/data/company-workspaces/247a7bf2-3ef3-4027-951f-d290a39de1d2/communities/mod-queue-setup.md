# #mod-queue Discord Channel Setup Guide

## Channel Overview

**Channel Name:** `#mod-queue`
**Purpose:** Central hub for submitting, tracking, and resolving community moderation reports
**SLA Target:** <2 hour response time
**Visibility:** Moderators, Community Managers, Growth & Brand Team

## Channel Configuration

```
Channel Name: #mod-queue
Topic: Submit moderation reports • <2hr SLA • @mods to react ⚡ to claim • ✅ when resolved
```

### Required Bot Integrations

1. **Main Mod Bot Roles**
- **Bot Name:** Mod_Queue / Automod
- **Permissions:** View Channel, Connect to mod-queue, Read History, Send Messages, Embed Links, Add Reactions
- **Channels:** mod-queue, #mod-logs, #mod-alerts

2. **Main Mod Bot Role:** Create a `@Mod_Queue_Bot` role and assign to the bot user

3. **Channel Permissions Matrix:**

| Role | View | Post | React | Thread |
|---------------------|------|------|-------|--------|
| @Moderators | ✅ | ✅ | ✅ | ✅ |
| @Community_Manager | ✅ | ✅ | ✅ | ✅ |
| @Growth_Team | ✅ | ✅ | ✅ | ✅ |
| @Bot_Mod_Queue_Bot | ✅ | ✅ | ✅ | ✅ |

## Reporting Workflow

### 1. Submit Report
- Community member uses `/report` slash command (if enabled) or direct message in `#mod-queue`
- Auto-tagged with emoji: ⚡🚀🔥🏆

### 2. Bot Notification
- Bot posts a system message
- Mod_Queue Bot auto-posts with emoji

### 3. Mod_Queue Bot auto-replies with detailed information
- Bot auto-replies with emoji: ⚡🚀

### 4. Mod_Queue Bot auto-posts with emoji: ⚡🚀

### 5. Mod_Queue Bot posts with emoji: ⚡🚀

## Moderation Workflow

1. **Trip Report**
- Mod_Queue Bot auto-posts with emoji: ⚡🚀🔥🏆📍

2. **Response SLA Tracker**
- Bot auto-replies with emoji: ⚡🚀🔥🏆

## Pinned Messages

1. **Welcome Guide/FAQ:** Link to Community Guidelines (TOUR-76)
2. **Reporting Template:** `/report` slash command structure
3. **SLA Tracker:** 📊 Karma/Economy bot integration

## Acceptance Criteria

- [ ] Channel created and visible in Discord server
- [ ] Bot integrations configured
- [ ] Auto-mod rules set up
- [ ] Pinned messages added
- [ ] Moderators trained on workflow

## Next Steps

1. Create `#mod-queue` channel on Discord server
2. Configure bot permissions and integrations
3. Set up auto-mod rules
4. Train moderators on workflow
5. Pin: ⚡ Community Guidelines Link
6. Pin: 📊 Mod_Reporting Template
7. Pin: 🏆 SLA Tracker

**Status:** Ready for implementation