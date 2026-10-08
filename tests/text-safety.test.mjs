import test from 'node:test';
import assert from 'node:assert/strict';
import {hasAsciiControl,stripAnsiCsi} from '../src/text-safety.mjs';

test('ASCII control validation preserves each original range and text whitespace exception',()=>{
  for(let code=0;code<=160;code++) {
    const value='readable '+String.fromCharCode(code)+' text';
    assert.equal(hasAsciiControl(value),code<32||code===127,'Strict range at '+code);
    assert.equal(hasAsciiControl(value,{includeDelete:false}),code<32,'C0 range at '+code);
    assert.equal(hasAsciiControl(value,{allowTextWhitespace:true}),code<32&&![9,10,13].includes(code)||code===127,'Multiline text range at '+code);
    assert.equal(hasAsciiControl(String.fromCharCode(code),{includeSpace:true}),code<=32||code===127,'Login URL range at '+code);
  }
  assert.equal(hasAsciiControl('한글 title 😀'),false);
  assert.equal(hasAsciiControl('line 1\tline 2\nline 3\r\n',{allowTextWhitespace:true}),false);
});

test('ANSI CSI stripping removes complete sequences and preserves non-CSI or incomplete escapes',()=>{
  const escape=String.fromCharCode(27);
  assert.equal(stripAnsiCsi('before'+escape+'[31mred'+escape+'[0mafter'),'beforeredafter');
  assert.equal(stripAnsiCsi(escape+'[?25lhidden'+escape+'[2Jclean'),'hiddenclean');
  assert.equal(stripAnsiCsi('before'+escape+'[31'),'before'+escape+'[31');
  assert.equal(stripAnsiCsi('before'+escape+']title'),'before'+escape+']title');
  assert.equal(stripAnsiCsi(escape+escape+'[31mtext'),escape+'text');
  assert.equal(stripAnsiCsi('한글 ordinary text'),'한글 ordinary text');
});
