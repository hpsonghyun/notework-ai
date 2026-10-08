import test from 'node:test';
import assert from 'node:assert/strict';
import {NoteworkUI} from '../src/ui.mjs';

class Node {
  constructor(tag,document){this.tagName=tag.toUpperCase();this.ownerDocument=document;this.children=[];this.dataset={};this.style={};this.attributes=new Map();this.className='';this._text='';this.classList={add:value=>{this.className+=' '+value;},contains:value=>this.className.split(/\s+/).includes(value),remove:value=>{this.className=this.className.split(/\s+/).filter(item=>item!==value).join(' ');}};}
  set textContent(value){this._text=String(value);}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  append(...nodes){for(const node of nodes){if(node.parentElement)node.parentElement.children=node.parentElement.children.filter(child=>child!==node);node.parentElement=this;this.children.push(node);}}
  setAttribute(name,value){this.attributes.set(name,String(value));}
  getAttribute(name){return this.attributes.get(name)??null;}
  addEventListener(){}
  matches(selector){return selector.startsWith('.')?this.classList.contains(selector.slice(1)):selector.startsWith('[aria-label=')?this.getAttribute('aria-label')===selector.slice(12,-1).replace(/^['"]|['"]$/g,''):this.tagName.toLowerCase()===selector;}
  closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
  querySelector(selector){for(const child of this.children){if(child.matches(selector))return child;const found=child.querySelector(selector);if(found)return found;}return null;}
}

function renderChat(surface,{isMobile=false,forbidScope=false}={}) {
  const previous=globalThis.document,document={createElement:tag=>new Node(tag,document),createElementNS:(_namespace,tag)=>new Node(tag,document)};globalThis.document=document;
  let scopeCalls=0;
  const parent=new Node('div',document),ui=Object.create(NoteworkUI.prototype);
  Object.assign(ui,{surface,isMobile,options:{},reasoningControls:()=>{},answerGeneration:()=>null,watchChatFeed:()=>{},controller:{scopeFiles:()=>{scopeCalls++;if(forbidScope)assert.fail('A restored runtime chat must not scan the vault for discarded context.');return [{path:'a.md'},{path:'b.md'},{path:'c.md'}];},vault:{getMarkdownFiles:()=>assert.fail('Runtime chat must not fall back to vault enumeration.')}}});
  const state={mode:'openai',models:[],model:'',busy:false,verified:false,knowledge:{index:null},messages:[],sources:[],attachments:[],draft:'',answer:''};
  try{ui.chat(parent,state);return{parent,scopeCalls};}finally{globalThis.document=previous;}
}

test('restored mobile workspace and desktop sidebar chat render without unused vault scope enumeration',()=>{
  for(const [surface,isMobile] of [['workspace',true],['sidebar',false]]){
    const {parent,scopeCalls}=renderChat(surface,{isMobile,forbidScope:true});assert.equal(scopeCalls,0);assert.equal(parent.querySelector('.nw-context-bar'),null);assert.ok(parent.querySelector('.nw-runtime-chat'));assert.ok(parent.querySelector('textarea'));assert.ok(parent.querySelector('.nw-composer-send'));
  }
});

test('a visible settings chat context still calculates and displays its scope count',()=>{
  const {parent,scopeCalls}=renderChat('settings');assert.equal(scopeCalls,1);assert.equal(parent.querySelector('.nw-context-scope').textContent,'3 notes in scope');assert.ok(parent.querySelector('.nw-context-bar'));assert.ok(parent.querySelector('textarea'));
});
