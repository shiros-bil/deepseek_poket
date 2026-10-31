"""Convert the original Lucide SVG geometry to Android vector drawables."""
from pathlib import Path
import xml.etree.ElementTree as ET
import base64
import json
from xml.sax.saxutils import escape
root=Path(__file__).resolve().parent.parent
icons=root/'app/src/main/assets/ui/icons'
urls={p.stem:'data:image/svg+xml;base64,'+base64.b64encode(p.read_bytes()).decode('ascii') for p in sorted(icons.glob('*.svg'))}
(icons.parent/'icons.js').write_text('// Original Lucide SVG bytes, embedded for offline WebView masks. See third-party/lucide.json.\nconst ICON_URLS='+json.dumps(urls,separators=(',',':'))+';\n',encoding='utf-8')

def geometry(el):
    tag=el.tag.split('}')[-1]
    n=lambda name,default=0:float(el.get(name,default))
    if tag=='path':return el.get('d')
    if tag=='line':return f'M{n("x1")},{n("y1")} L{n("x2")},{n("y2")}'
    if tag=='circle':
        x,y,r=n('cx'),n('cy'),n('r')
        return f'M{x-r},{y} a{r},{r} 0 1,0 {2*r},0 a{r},{r} 0 1,0 {-2*r},0'
    if tag=='rect':
        x,y,w,h=n('x'),n('y'),n('width'),n('height');r=n('rx')
        return f'M{x+r},{y} H{x+w-r} A{r},{r} 0 0,1 {x+w},{y+r} V{y+h-r} A{r},{r} 0 0,1 {x+w-r},{y+h} H{x+r} A{r},{r} 0 0,1 {x},{y+h-r} V{y+r} A{r},{r} 0 0,1 {x+r},{y} Z'
    raise ValueError(tag)

for source,target,background in [('server','ic_notification',False)]:
    tree=ET.parse(icons/(source+'.svg')).getroot()
    size=48 if background else 24
    lines=[f'<!-- Geometry from Lucide {source}.svg; see assets/licenses/Lucide.txt. -->',f'<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="{size}dp" android:height="{size}dp" android:viewportWidth="24" android:viewportHeight="24">']
    if background:lines.append('<path android:fillColor="#111111" android:pathData="M0,0h24v24h-24z"/>')
    for el in tree:
        lines.append(f'<path android:pathData="{escape(geometry(el))}" android:fillColor="@android:color/transparent" android:strokeColor="#FFFFFF" android:strokeWidth="2" android:strokeLineCap="round" android:strokeLineJoin="round"/>')
    lines.append('</vector>')
    (root/'app/src/main/res/drawable'/(target+'.xml')).write_text('\n'.join(lines)+'\n',encoding='utf-8')
print('Lucide SVGs embedded for the UI; server geometry converted to the notification vector.')
