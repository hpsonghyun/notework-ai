/** Preserve the ASCII control ranges used by persisted text and path validation. */
export function hasAsciiControl(value,{allowTextWhitespace=false,includeDelete=true,includeSpace=false}={}) {
  for(let at=0;at<value.length;at++) {
    const code=value.charCodeAt(at);
    if(code<32&&!(allowTextWhitespace&&(code===9||code===10||code===13))||includeDelete&&code===127||includeSpace&&code===32)return true;
  }
  return false;
}

/** Strip complete ANSI CSI sequences while retaining unrelated escape bytes. */
export function stripAnsiCsi(value) {
  const escape=String.fromCharCode(27),parts=value.split(escape);
  return parts[0]+parts.slice(1).map(part=>/^\[[0-?]*[ -/]*[@-~]/.test(part)?part.replace(/^\[[0-?]*[ -/]*[@-~]/,''):escape+part).join('');
}
