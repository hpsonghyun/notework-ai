// Conservative section boundaries for separately rendered host Markdown.
// A target is a scheduling budget, never permission to cut an atomic block.
const columns=value=>[...value].reduce((at,char)=>char==='\t'?at+4-at%4:at+1,0);
const indentation=value=>columns(value.match(/^[ \t]*/)[0]);
function containerPrefix(line,inList=false){
  let body=line,depth=0,quotedAt=0,at=0;const markers=[];
  for(let step=0;step<64;step++){
    const whitespace=body.match(/^[ \t]*/)[0],rest=body.slice(whitespace.length);
    if(rest.startsWith('>')&&(columns(whitespace)<=3||inList||markers.length)){
      const prefix=whitespace+'>'+rest.slice(1).match(/^[ \t]?/)[0];at+=prefix.length;body=body.slice(prefix.length);depth++;quotedAt=columns(line.slice(0,at));continue;
    }
    const marker=rest.match(/^(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/);
    if(marker&&(columns(whitespace)<=3||inList||markers.length)){
      const prefix=whitespace+marker[0];at+=prefix.length;body=body.slice(prefix.length);markers.push({depth,indent:columns(line.slice(0,at))-quotedAt});continue;
    }
    break;
  }
  return {body,depth,markers,bodyIndent:indentation(body),listIndent:markers.length?Math.max(0,columns(line.slice(0,at))-quotedAt):0};
}
function advanceInlineCode(line,run){
  for(let at=0;at<line.length;at++){
    if(line[at]!=='`')continue;
    let slashes=0;for(let before=at-1;before>=0&&line[before]==='\\';before--)slashes++;
    const ticks=line.slice(at).match(/^`+/)[0];at+=ticks.length-1;
    if(run){if(ticks===run)run=null;}else if(slashes%2===0)run=ticks;
  }
  return run;
}
/** Exact contiguous strings. Append-only input retains every completed prefix
 * section; document-wide definitions conservatively require one host render. */
export function splitChatMarkdownSections(value,{targetCharacters=4096}={}){
  const text=String(value??'');if(!text)return [];
  const target=Number.isFinite(targetCharacters)&&targetCharacters>0?Math.floor(targetCharacters)||1:4096;
  const sections=[],definitionLines=[];let offset=0,start=0,fence=null,list=null,quote=false,inlineCode=null,math=false,previousBlank=false,global=false;
  for(const line of text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)||[]){
    if(!line)continue;
    const raw=line.replace(/(?:\r\n|\r|\n)$/,''),ending=line.slice(raw.length),blank=!raw.trim(),prefix=containerPrefix(raw,!!list),indent=indentation(raw);
    if(fence){
      const body=fence.depth?prefix.body:raw;
      const closing=body.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
      if(prefix.depth===fence.depth&&closing&&closing[1][0]===fence.char&&closing[1].length>=fence.length&&indentation(body)>=fence.indent&&indentation(body)<=fence.indent+3)fence=null;
      previousBlank=false;offset+=line.length;continue;
    }
    if(math){if(raw.trim().endsWith('$$'))math=false;previousBlank=false;offset+=line.length;continue;}
    const heading=/^ {0,3}#{1,6}(?:[ \t]|$)/.test(raw);
    if(list&&(prefix.depth!==list.depth||(!blank&&!prefix.markers.length&&prefix.bodyIndent<list.indent&&(previousBlank||heading))))list=null;
    if(quote&&!blank&&!prefix.depth&&(previousBlank||heading))quote=false;
    const nested=!!list||!!prefix.depth||prefix.markers.length>0;
    const indented=!nested&&indent>=4;
    if(blank)inlineCode=null;
    const boundary=!blank&&!nested&&!quote&&!indented&&!inlineCode&&(heading||previousBlank);
    if(boundary&&offset-start>=target){sections.push(text.slice(start,offset));start=offset;}
    if(prefix.markers.length){const outer=prefix.markers[0];if(!list||list.depth!==outer.depth)list=outer;else list={...list,indent:Math.min(list.indent,outer.indent)};}
    if(prefix.depth)quote=true;
    const body=prefix.body;
    const relativeIndent=prefix.markers.length?prefix.listIndent:list?.depth===prefix.depth?list.indent:0;
    definitionLines.push(body+ending);
    const opening=body.match(/^[ \t]*(`{3,}|~{3,})([^\r\n]*)$/);
    if(opening&&!indented&&indentation(body)<=relativeIndent+3&&(opening[1][0]!=='`'||!opening[2].includes('`'))){
      fence={depth:prefix.depth,indent:relativeIndent,char:opening[1][0],length:opening[1].length};inlineCode=null;
    }else if(!indented){
      // Definitions can have multiline labels and live inside containers.
      if(/^[ \t]*<(?:[A-Za-z!/?])/.test(body)||body.includes('%%')||/(?:^|[^\\])\^\[/.test(body))global=true;
      if(body.trim().startsWith('$$')&&(body.trim().length===2||!body.trim().slice(2).includes('$$')))math=true;
      else inlineCode=advanceInlineCode(body,inlineCode);
    }
    previousBlank=blank;offset+=line.length;
  }
  const definitions=definitionLines.join('');
  if(global||/^[ \t]{0,3}\[(?:\\.|[^\]\\])+\]:/m.test(definitions))return [text];
  if(start<text.length)sections.push(text.slice(start));return sections;
}
