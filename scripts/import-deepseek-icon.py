"""Import DeepSeek's SVG mark as a black Android launcher icon."""
from pathlib import Path
import re
import xml.etree.ElementTree as ET
root=Path(__file__).resolve().parent.parent
source=root/'third-party/deepseek/deepseek.svg'
svg=ET.parse(source).getroot()

def normalize_path(data):
    counts={'M':2,'L':2,'H':1,'V':1,'C':6,'S':4,'Q':4,'T':2,'A':7}
    number=re.compile(r'[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?')
    pos=0;command=None;output=[]
    def skip():
        nonlocal pos
        while pos<len(data) and data[pos] in ' ,\t\r\n':pos+=1
    while pos<len(data):
        skip()
        if pos>=len(data):break
        if data[pos].isalpha():
            command=data[pos];pos+=1
            if command.upper()=='Z':output.append(command);command=None;continue
        assert command is not None
        values=[]
        for i in range(counts[command.upper()]):
            skip()
            if command.upper()=='A' and i in [3,4]:
                assert data[pos] in '01';values.append(data[pos]);pos+=1
            else:
                match=number.match(data,pos);assert match,(pos,data[pos:pos+30]);values.append(match.group());pos=match.end()
        output.append(command+' '+','.join(values))
        if command=='M':command='L'
        elif command=='m':command='l'
    return ' '.join(output)

paths=[normalize_path(el.get('d')) for el in svg.iter() if el.tag.endswith('}path')]
assert paths
def vector(viewport,scale,translate,background):
    result=[f'<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="{viewport}dp" android:height="{viewport}dp" android:viewportWidth="{viewport}" android:viewportHeight="{viewport}">']
    if background:result.append(f'<path android:fillColor="#FFFFFF" android:pathData="M0,0h{viewport}v{viewport}h-{viewport}z"/>')
    result.append(f'<group android:scaleX="{scale}" android:scaleY="{scale}" android:translateX="{translate}" android:translateY="{translate}">')
    for d in paths:result.append(f'<path android:fillColor="#000000" android:fillType="evenOdd" android:pathData="{d}"/>')
    return '\n'.join(result+['</group>','</vector>'])+'\n'
drawable=root/'app/src/main/res/drawable'
(drawable/'ic_app.xml').write_text(vector(24,.8,2.4,True),encoding='utf-8')
(drawable/'ic_deepseek_foreground.xml').write_text(vector(108,2.6,22.8,False),encoding='utf-8')
mipmap=root/'app/src/main/res/mipmap-anydpi-v26';mipmap.mkdir(parents=True,exist_ok=True)
(mipmap/'ic_launcher.xml').write_text('<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n<background android:drawable="@color/launcher_background"/>\n<foreground android:drawable="@drawable/ic_deepseek_foreground"/>\n</adaptive-icon>\n',encoding='utf-8')
(root/'app/src/main/res/values/launcher.xml').write_text('<resources><color name="launcher_background">#FFFFFF</color></resources>\n',encoding='utf-8')
print('Imported DeepSeek mark: black foreground, white adaptive background.')
