"""
Tourbillon Discord Server Setup Script
======================================
Creates and configures the Tourbillon community Discord server with proper
channels, roles, permissions, and initial welcome message.

Prerequisites:
- Python 3.8+
- discord.py library (pip install discord.py)
- Discord Bot Token with appropriate permissions
- .env file or environment variables configured

Usage:
    python scripts/discord-setup.py
    
Environment Variables Required:
    DISCORD_BOT_TOKEN     - Your Discord bot token
    SERVER_NAME           - Name of the server (default: "Tourbillon")
"""

import os
import sys
import asyncio
from pathlib import Path

try:
    import discord
    from dotenv import load_dotenv
except ImportError:
    print("❌ Required packages not installed. Run:")
    print("   pip install discord.py python-dotenv")
    sys.exit(1)


# Load environment variables
load_dotenv()

BOT_TOKEN = os.getenv('DISCORD_BOT_TOKEN')
if not BOT_TOKEN:
    print("❌ DISCORD_BOT_TOKEN environment variable not set.")
    print("   Please create a .env file with your Discord bot token.")
    sys.exit(1)


# ============================================================
# Configuration
# ============================================================

SERVER_NAME = os.getenv('SERVER_NAME', 'Tourbillon - AI Agent Orchestration')

CATEGORIES = [
    {
        "name": "📢 Information",
        "channels": [
            {"name": "welcome", "type": discord.TextChannel, "topic": "Welcome to Tourbillon! Read this first."},
            {"name": "announcements", "type": discord.TextChannel, "topic": "Official announcements and updates.", "permission_overrides": {
                # Only admins/mods can post here
            }},
        ]
    },
    {
        "name": "💬 Community",
        "channels": [
            {"name": "general", "type": discord.TextChannel, "topic": "General discussion about Tourbillon and AI agent orchestration."},
            {"name": "showcase", "type": discord.TextChannel, "topic": "Share your workflows and projects built with Tourbillon!"},
            {"name": "off-topic", "type": discord.TextChannel, "topic": "Non-Tourbillon related discussions. Be kind."},
        ]
    },
    {
        "name": "🛟 Support",
        "channels": [
            {"name": "help-support", "type": discord.TextChannel, "topic": "Get help with Tourbillon setup and usage."},
        ]
    },
    {
        "name": "✨ Feedback",
        "channels": [
            {"name": "feature-requests", "type": discord.TextChannel, "topic": "Suggest new features or improvements. Vote on others' ideas!"},
        ]
    }
]

ROLES = [
    {
        "name": "Admin",
        "color": discord.Color.red(),
        "permissions": discord.Permissions.all()
    },
    {
        "name": "Moderator",
        "color": discord.Color.blue(),
        "permissions": discord.Permissions(
            manage_channels=True,
            manage_messages=True,
            kick_members=True,
            ban_members=True,
            moderate_members=True,  # Timeout
            view_audit_log=True,
            add_reactions=True,
            read_message_history=True,
            send_messages=True,
        )
    },
    {
        "name": "Early Adopter",
        "color": discord.Color.gold(),
        "permissions": discord.Permissions(
            read_message_history=True,
            send_messages=True,
            add_reactions=True,
            embed_links=True,
            attach_files=True,
        ),
        "hoist": True,  # Display separately in member list
    },
]

WELCOME_MESSAGE = """🎉 **Welcome to Tourbillon!** 🌪️

You're now part of the community building the future of AI agent orchestration.

**Getting Started:**
- 📖 Read `#welcome` for community guidelines
- 💬 Join the conversation in `#general`
- 🛟 Need help? Post in `#help-support`
- ✨ Have ideas? Share them in `#feature-requests`

**Quick Links:**
- 🔗 [Tourbillon Website](https://tourbillon.app)
- 📚 [Documentation](https://docs.tourbillon.app)
- 💻 [GitHub Repository](https://github.com/tourbillon/core)
- 🐦 [Twitter/X](https://twitter.com/tourbillon_ai)

**Founder Offer:** First 500 members get a free 3-month Pro trial!

Enjoy the vortex! 🌊"""


# ============================================================
# Setup Functions
# ============================================================

async def create_roles(bot: discord.Client, guild: discord.Guild):
    """Create all roles if they don't already exist."""
    print("📝 Creating roles...")
    
    for role_config in ROLES:
        existing = await guild.fetch_role(role_config['permissions'] if 'permissions' in role_config else discord.Permissions())
        
        # Check if role exists
        role_exists = False
        for r in guild.roles:
            if r.name == role_config['name']:
                role_exists = True
                print(f"  ✓ Role '{r.name}' already exists")
                break
        
        if not role_exists:
            try:
                role = await guild.create_role(
                    name=role_config['name'],
                    color=role_config.get('color', discord.Color.default()),
                    permissions=role_config.get('permissions', discord.Permissions.default()),
                    hoist=role_config.get('hoist', False),
                    reason="Tourbillon Discord setup"
                )
                print(f"  ✓ Created role '{role.name}'")
            except discord.Forbidden:
                print(f"  ⚠️ Insufficient permissions to create role '{role_config['name']}'")
            except Exception as e:
                print(f"  ❌ Error creating role '{role_config['name']}': {e}")


async def create_categories(bot: discord.Client, guild: discord.Guild):
    """Create all categories."""
    print("📁 Creating categories...")
    
    for cat_config in CATEGORIES:
        # Check if category exists
        cat_exists = False
        for cat in guild.categories:
            if cat.name == cat_config['name']:
                cat_exists = True
                break
        
        if not cat_exists:
            try:
                await guild.create_category(cat_config['name'], reason="Tourbillon Discord setup")
                print(f"  ✓ Created category '{cat_config['name']}'")
            except discord.Forbidden:
                print(f"  ⚠️ Insufficient permissions to create category '{cat_config['name']}'")


async def create_channels(bot: discord.Client, guild: discord.Guild):
    """Create all text channels within their categories."""
    print("💬 Creating channels...")
    
    for cat_config in CATEGORIES:
        # Find the category
        category = None
        for cat in guild.categories:
            if cat.name == cat_config['name']:
                category = cat
                break
        
        if not category:
            print(f"  ⚠️ Category '{cat_config['name']}' not found, skipping channels")
            continue
        
        for channel_config in cat_config['channels']:
            # Check if channel exists
            channel_exists = False
            for ch in category.text_channels:
                if ch.name == channel_config['name']:
                    channel_exists = True
                    print(f"  ✓ Channel '{ch.name}' already exists")
                    break
            
            if not channel_exists:
                try:
                    channel = await guild.create_text_channel(
                        name=channel_config['name'],
                        category=category,
                        topic=channel_config.get('topic', ''),
                        reason="Tourbillon Discord setup"
                    )
                    print(f"  ✓ Created channel '{category.name}/{channel.name}'")
                    
                    # Set up permission overwrites if specified
                    if 'permission_overrides' in channel_config:
                        for role_or_member, overwrite in channel_config['permission_overrides'].items():
                            try:
                                await channel.set_permissions(role_or_member, **overwrite)
                                print(f"    ✓ Set permissions for {role_or_member}")
                            except Exception as e:
                                print(f"    ⚠️ Could not set permissions for {role_or_member}: {e}")
                                
                except discord.Forbidden:
                    print(f"  ⚠️ Insufficient permissions to create channel '{channel_config['name']}'")
                except Exception as e:
                    print(f"  ❌ Error creating channel '{channel_config['name']}': {e}")


async def send_welcome_message(bot: discord.Client, guild: discord.Guild):
    """Send welcome message in the #welcome channel."""
    print("📤 Sending welcome message...")
    
    # Find the welcome channel
    welcome_channel = None
    for category in CATEGORIES:
        for ch_config in category['channels']:
            if ch_config['name'] == 'welcome':
                for cat in guild.categories:
                    if cat.name == category['name']:
                        for ch in cat.text_channels:
                            if ch.name == 'welcome':
                                welcome_channel = ch
                                break
                break
    
    if not welcome_channel:
        print("  ⚠️ Welcome channel not found, skipping message")
        return
    
    try:
        await welcome_channel.send(WELCOME_MESSAGE)
        print(f"  ✓ Welcome message sent to #{welcome_channel.name}")
    except Exception as e:
        print(f"  ❌ Error sending welcome message: {e}")


async def setup_integrations(guild: discord.Guild):
    """Set up any additional integrations or webhooks."""
    print("🔗 Setting up integrations...")
    
    # Add GitHub webhook if configured
    github_url = os.getenv('GITHUB_WEBHOOK_URL')
    if github_url:
        try:
            channel = None
            for category in CATEGORIES:
                for ch_config in category['channels']:
                    if 'announcements' in ch_config['name']:
                        for cat in guild.categories:
                            if cat.name == category['name']:
                                for ch in cat.text_channels:
                                    if ch.name == 'announcements':
                                        channel = ch
                                        break
        
            if channel:
                await channel.create_webhook(
                    name="GitHub",
                    avatar=Path("https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png"),
                    reason="Tourbillon Discord setup"
                )
                print(f"  ✓ Created GitHub webhook in #{channel.name}")
        except Exception as e:
            print(f"  ⚠️ Could not create GitHub webhook: {e}")


# ============================================================
# Main Execution
# ============================================================

async def main():
    """Main entry point for the Discord setup script."""
    print("=" * 60)
    print("🌪️ Tourbillon Discord Server Setup")
    print("=" * 60)
    
    # Create bot instance with required intents
    intents = discord.Intents.default()
    intents.message_content = True
    intents.messages = True
    intents.guilds = True
    intents.members = True
    
    bot = discord.Bot(intents=intents)
    
    @bot.event
    async def on_ready():
        print(f"✅ Bot logged in as {bot.user} ({bot.user.id})")
        
        # Check if we're connected to the expected guild
        if len(bot.guilds) == 0:
            print("❌ Bot is not in any guild. Invite it first:")
            print("   https://discord.com/oauth2/authorize?client_id=" + bot.user.id + "&permissions=8&scope=bot")
            sys.exit(1)
        
        guild = bot.guilds[0]  # Use the first (and usually only) guild
        
        if guild.name != SERVER_NAME:
            print(f"⚠️ Connected to '{guild.name}', expected '{SERVER_NAME}'")
            response = input("Proceed with this server? (y/n): ")
            if response.lower() != 'y':
                sys.exit(0)
        
        print(f"\n📋 Setting up: {guild.name} ({guild.id})")
        print("-" * 60)
        
        # Execute setup steps in order
        await create_roles(bot, guild)
        await create_categories(bot, guild)
        await create_channels(bot, guild)
        await send_welcome_message(bot, guild)
        await setup_integrations(guild)
        
        print("-" * 60)
        print("✅ Setup complete!")
        print("\n📝 Next Steps:")
        print(f"   - Invite team members to {guild.name}")
        print(f"   - Configure role assignments")
        print(f"   - Set up additional integrations as needed")
        
        # Keep bot connected for a few seconds to ensure completion
        await asyncio.sleep(2)
        await bot.close()
    
    try:
        await bot.start(BOT_TOKEN)
    except discord.LoginFailure:
        print("❌ Invalid bot token. Please check your DISCORD_BOT_TOKEN.")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n⚠️ Setup interrupted by user.")
        sys.exit(130)


if __name__ == "__main__":
    asyncio.run(main())
