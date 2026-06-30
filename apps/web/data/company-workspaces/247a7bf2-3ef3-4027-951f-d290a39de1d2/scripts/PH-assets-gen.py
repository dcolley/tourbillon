#!/usr/bin/env python3
"""Generate Product Hunt visual assets for Tourbillon launch."""
import subprocess, sys, os

IM = "magick"  # ImageMagick v7
OUT = "../deliverables/product-hunt"

def run(args):
    print("  CMD: " + " ".join(args[:5]))
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        print("  STDERR: " + r.stderr[-500:])
        sys.exit(1)

def main():
    # =========================================
    # 1. COVER IMAGE (1200x630)
    # =========================================
    print("\n[1/8] Cover image (1200x630)...")
    
    run([IM, "-size", "1200x630", "xc:#0a0f1e", OUT + "/cover/bg.png"])
    run([IM, OUT + "/cover/bg.png",
         "-fill #6366f140 -stroke none -draw 'circle 850,280 700,280'",
         "-fill #6366f120 -stroke none -draw 'circle 950,220 800,220'",
         OUT + "/cover/bg2.png"])
    run([IM, OUT + "/cover/bg2.png",
         "-fill none -stroke #6366f1 -strokewidth 2 -draw 'roundrectangle 45,45 1155,585 15,15'",
         OUT + "/cover/bg3.png"])
    run([IM, OUT + "/cover/bg3.png",
         "-gravity north -pointsize 20 -fill #a5b4fc -annotate +0+60 'MULTI-AGENT ORCHESTRATION PLATFORM'",
         "-gravity center -pointsize 72 -fill #000000aa -annotate +3+3 'Tourbillon'",
         "-gravity center -pointsize 72 -fill #ffffff -annotate +0+0 'Tourbillon'",
         OUT + "/cover/text1.png"])
    run([IM, OUT + "/cover/text1.png",
         "-gravity south -pointsize 26 -fill #c7d2fe -annotate +0-45 'Build   Orchestrate   Deploy - Zero Code Required'",
         "-gravity north -pointsize 22 -fill #a5b4fc -annotate +0+30 '** PH Launching Now **'",
         OUT + "/cover/final.png"])
    run([IM, "-size", "300x50", "xc:#6366f1",
         "-fill white -pointsize 22 -gravity center -annotate +0+0 '** PH Launching Now **'",
         OUT + "/cover/ph-badge.png"])
    run([IM, OUT + "/cover/final.png",
         OUT + "/cover/ph-badge.png",
         "-geometry +30+25", "-composite",
         OUT + "/cover/cover-image.png"])
    print("  -> " + OUT + "/cover/cover-image.png")

    # =========================================
    # 2. LOGO (512x512)
    # =========================================
    print("\n[2/8] Logo...")
    run([IM, "-size", "512x512", "xc:none",
         "-fill none -stroke #6366f1 -strokewidth 8 -draw 'circle 256,256 256,40'",
         "-fill #6366f180 -stroke none -draw 'circle 256,256 256,100'",
         "-fill #c7d2fe -stroke none -draw 'circle 256,256 256,45'",
         "-fill none -stroke #a5b4fc -strokewidth 3 -draw 'circle 256,256 256,180'",
         "-fill none -stroke #a5b4fc -strokewidth 2 -draw 'line 256,76 256,100'",
         "-fill none -stroke #a5b4fc -strokewidth 2 -draw 'line 256,412 256,436'",
         "-fill none -stroke #a5b4fc -strokewidth 2 -draw 'line 76,256 100,256'",
         "-fill none -stroke #a5b4fc -strokewidth 2 -draw 'line 412,256 436,256'",
         "-fill #6366f1 -stroke none -draw 'circle 256,256 256,70'",
         "-fill #ffffff -stroke none -draw 'rectangle 253,243 259,269'",
         "-fill #ffffff -stroke none -draw 'rectangle 243,253 269,259'",
         OUT + "/cover/logo.png"])
    print("  -> " + OUT + "/cover/logo.png")

    # =========================================
    # 3. FEATURE SCREENSHOTS (960x540)
    # =========================================
    print("\n[3/8] Feature screenshots...")
    
    features = [
        ("visual-builder", "Visual Agent Builder", 
         "Drag-and-drop canvas to design multi-agent workflows"),
        ("multi-agent-handoff", "Multi-Agent Handoff",
         "Agents reason, decide and pass rich context between each other"),
        ("human-in-loop", "Human-in-the-Loop Control",
         "Approval gates at every step - full autonomy with control"),
        ("deploy-monitor", "One-Click Deploy and Monitor",
         "Auto-scaling, load balancing and real-time dashboards"),
    ]
    
    for name, title, desc in features:
        run([IM, "-size", "960x540", "xc:#0a0f1e",
             "-fill #1e293b -stroke none -draw 'rectangle 0,0 960,60'",
             "-gravity north -pointsize 20 -fill #a5b4fc -annotate +0+18 'Tourbillon'",
             "-gravity center -pointsize 48 -fill #ffffff -annotate +0-30 '" + title + "'",
             "-gravity south -pointsize 22 -fill #94a3b8 -annotate +0+60 '" + desc + "'",
             OUT + "/feature-highlights/" + name + ".png"])
        print("  -> " + name)

    # =========================================
    # 4. SOCIAL BADGES
    # =========================================
    print("\n[4/8] Social media badges...")
    
    badge_specs = [
        ("badge-twitter", "Twitter / X", 1200, 675),
        ("badge-linkedin", "LinkedIn", 1200, 627),
        ("badge-slack", "Slack", 800, 400),
        ("badge-discord", "Discord", 800, 400),
    ]
    
    for name, platform, w, h in badge_specs:
        pt_main = str(int(h * 0.08))
        pt_sub = str(int(h * 0.04))
        offset = str(h // 2 - 10)
        
        run([IM, "-size", str(w) + "x" + str(h), "xc:#0a0f1e",
             "-fill #6366f1 -stroke none -draw 'roundrectangle 20,20 " + str(w-20) + "," + str(h-20) + " 20,20'",
             "-gravity center -pointsize " + pt_main + " -fill #ffffff",
             "-annotate +0+0 'Upvote Tourbillon on Product Hunt!'",
             "-gravity south -pointsize " + pt_sub + " -fill #a5b4fc",
             "-annotate +0+" + offset + " 'Support us on " + platform + "'",
             OUT + "/badges/" + name + ".png"])
        print("  -> " + name)

    # =========================================
    # 5. HERO VIDEO (silent loop, 60s)
    # =========================================
    print("\n[5/8] Hero video...")
    
    frame_defs = [
        ("frame-01", "Tourbillon", 
         ["Multi-Agent Orchestration Platform", "", "Build   Orchestrate   Deploy"]),
        ("frame-02", "Visual Agent Builder",
         ["Drag-and-drop canvas for multi-agent workflows",
          "No code required - anyone can build AI automations"]),
        ("frame-03", "Multi-Agent Handoff",
         ["Agents reason and pass rich context to each other",
          "With confidence scores and recommendations"]),
        ("frame-04", "Human-in-the-Loop",
         ["Approval gates at every step",
          "Full autonomy with full control"]),
        ("frame-05", "One-Click Deploy",
         ["Auto-scaling and real-time dashboards",
          "Observability out of the box"]),
        ("frame-06", "Start Free Today",
         ["No credit card required", "", "tourbillon.io"]),
    ]
    
    for fname, title, lines in frame_defs:
        cmd = [IM, "-size", "1920x1080", "xc:#0a0f1e"]
        cmd.extend(["-fill #6366f140 -stroke none -draw 'circle 960,540 760,540'"])
        
        if title:
            cmd.extend(["-gravity", "center", "-pointsize", "64", 
                        "-fill", "#ffffff", "-annotate", "+0+0", "'" + title + "'"])
        
        for i, line in enumerate(lines):
            offset = 120 + (i * 50)
            cmd.extend(["-gravity", "south", "-pointsize", "32", 
                        "-fill", "#94a3b8", "-annotate", "+0+" + str(offset), "'" + line + "'"])
        
        cmd.append(OUT + "/videos/" + fname + ".png")
        run(cmd)
    
    print("  Encoding video...")
    frame_paths = [OUT + "/videos/" + f for f, _, _ in frame_defs]
    run([IM, "-delay", "25", "-loop", "9999"] + 
        frame_paths +
        [OUT + "/videos/hero-video.mp4"])
    
    print("  -> " + OUT + "/videos/hero-video.mp4")

    # =========================================
    # 6. VOTE BADGES
    # =========================================
    print("\n[6/8] Vote badges...")
    
    run([IM, "-size", "320x100", "xc:none",
         "-fill #276749 -stroke none -draw 'roundrectangle 5,5 315,95 10,10'",
         "-gravity center -pointsize 28 -fill #ffffff",
         "-annotate +0+0 '** Upvote on Product Hunt! **'",
         OUT + "/badges/vote-badge.png"])
    
    run([IM, "-size", "420x130", "xc:none",
         "-fill #276749 -stroke none -draw 'roundrectangle 5,5 415,125 10,10'",
         "-gravity center -pointsize 32 -fill #ffffff",
         "-annotate +0+0 '** Upvote Tourbillon on Product Hunt! **'",
         OUT + "/badges/vote-badge-large.png"])
    
    print("  -> " + OUT + "/badges/")

    # =========================================
    # 7. APP ICON (512x512)
    # =========================================
    print("\n[7/8] App icon...")
    run([IM, "-size", "512x512", "xc:#6366f1",
         "-fill none -stroke #ffffff -strokewidth 4 -draw 'circle 256,256 256,80'",
         "-fill #ffffff -stroke none -draw 'circle 256,256 256,130'",
         "-fill none -stroke #a5b4fc -strokewidth 3",
         "-draw 'line 256,126 256,150'",
         "-draw 'line 256,362 256,386'",
         "-draw 'line 126,256 150,256'",
         "-draw 'line 362,256 386,256'",
         OUT + "/cover/app-icon.png"])
    
    print("  -> " + OUT + "/cover/app-icon.png")

    # =========================================
    # 8. CLEANUP & VERIFY
    # =========================================
    print("\n[8/8] Cleanup and verify...")
    keep_prefixes = ["cover-image", "logo.", "app-icon", "vote-badge", "badge-"]
    for f in os.listdir("."):
        if f.endswith('.png') and not any(p in f for p in keep_prefixes):
            try:
                os.remove(f)
            except OSError:
                pass
    
    print("\n" + "="*60)
    print("ALL PRODUCT HUNT VISUAL ASSETS GENERATED")
    print("="*60)
    
    total_size = 0
    for root, dirs, files in os.walk(OUT):
        level = root.replace(OUT, "").count(os.sep)
        indent = "  " * level
        print(indent + os.path.basename(root) + "/")
        subindent = "  " * (level + 1)
        for f in sorted(files):
            size = os.path.getsize(os.path.join(root, f))
            total_size += size
            if size > 1024*1024:
                print(subindent + f + " (" + str(round(size/1024**2, 1)) + " MB)")
            else:
                print(subindent + f + " (" + str(round(size/1024, 1)) + " KB)")
    
    if total_size > 1024*1024:
        print("\nTotal: " + str(round(total_size/1024**2, 1)) + " MB")
    else:
        print("\nTotal: " + str(round(total_size/1024, 1)) + " KB")

if __name__ == "__main__":
    main()
