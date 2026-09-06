from PIL import Image, ImageDraw, ImageFont
import os

# Create icons directory
icons_dir = r"C:\Users\RUDRANKSH PARIAL\Documents\Project\SkelIO\icons"
os.makedirs(icons_dir, exist_ok=True)

def create_icon(size, path):
    # Create image with dark grey background
    img = Image.new('RGB', (size, size), color='#1E1E1E')
    draw = ImageDraw.Draw(img)

    # Draw white "S" letter
    font_size = int(size * 0.6)
    try:
        # Try to use a system font
        font = ImageFont.truetype("arial.ttf", font_size)
    except:
        # Fallback to default font
        font = ImageFont.load_default()

    # Draw text centered
    text = "S"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]

    x = (size - text_width) // 2
    y = (size - text_height) // 2

    draw.text((x, y), text, fill='#FFFFFF', font=font)

    # Save
    img.save(path)
    print(f"Created {path}")

# Generate all icon sizes
create_icon(16, os.path.join(icons_dir, "icon16.png"))
create_icon(32, os.path.join(icons_dir, "icon32.png"))
create_icon(48, os.path.join(icons_dir, "icon48.png"))
create_icon(128, os.path.join(icons_dir, "icon128.png"))

print("All icons generated successfully!")
