# Code Context

inlineEdits
function actionBar(actions: IAction[], options: IActionBarOptions)
function hoverContent(content: ChildNode)

## Snapshots

- src: vscode-scale@scale-1788853146362 project=project-1133a0288d95fd93d6132ebf analysis=2818a6f8247c7076bac3a04b220246a01a3a498b91556246beb680458bd6a5b9

## Retrieval
module -> module (user)
The user-selected granularity determines primary results; supporting evidence may cross granularities.

## Relevant Implementations

- actionbar [module] vscode-scale@scale-1788853146362:vs/base/browser/ui/actionbar/actionbar.ts
  Matched this node summary. actionbar: 2 files, 148 declarations.

- components [module] vscode-scale@scale-1788853146362:vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/components/gutterIndicatorMenu.ts
  Matched this node summary. components: 2 files, 127 declarations.

- inlineEdits [module] vscode-scale@scale-1788853146362:vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/components/gutterIndicatorMenu.ts
  Matched this node summary. inlineEdits: 26 files, 1170 declarations.

- ui [module] vscode-scale@scale-1788853146362:vs/base/browser/ui/actionbar/actionbar.ts
  Matched this node summary. ui: 76 files, 5171 declarations.

- promptCodeActions.test.ts [module] vscode-scale@scale-1788853146362:vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptCodeActions.test.ts
  Matched this node summary. promptCodeActions.test.ts: 1 files, 47 declarations.

- actions [module] vscode-scale@scale-1788853146362:vs/platform/actions/browser/actionbar.ts
  Matched this node summary. actions: 14 files, 423 declarations.

- actions [module] vscode-scale@scale-1788853146362:vs/workbench/electron-browser/actions/developerActions.ts
  Matched this node summary. actions: 3 files, 145 declarations.

- actions [module] vscode-scale@scale-1788853146362:vs/workbench/browser/actions/developerActions.ts
  Matched this node summary. actions: 12 files, 828 declarations.

- Local files [module] vscode-scale@scale-1788853146362:vs/base/common/actions.ts
  Matched this node summary. Local files: 108 files, 5452 declarations.

- actions [module] vscode-scale@scale-1788853146362:vs/workbench/contrib/chat/electron-browser/actions/chatDeveloperActions.ts
  Matched this node summary. actions: 7 files, 262 declarations.

## Relations

- vscode-scale@scale-1788853146362: vs/base/browser/ui/actionbar/actionbar.ts --import (unresolved, unresolved)--> ../hover/hoverDelegateFactory.js

- vscode-scale@scale-1788853146362: symbol:d7bae40472c8ec6a1bf8101c --export (resolved, syntactic)--> SelectActionViewItem

- vscode-scale@scale-1788853146362: vs/base/browser/ui/actionbar/actionbar.ts --import (unresolved, unresolved)--> ../../../common/keyCodes.js

- vscode-scale@scale-1788853146362: symbol:dbae70881f50123cbef764af --export (resolved, syntactic)--> ActionViewItem

- vscode-scale@scale-1788853146362: vs/base/browser/ui/actionbar/actionViewItems.ts --import (unresolved, unresolved)--> ../../../common/actions.js

- vscode-scale@scale-1788853146362: vs/base/browser/ui/actionbar/actionViewItems.ts --import (unresolved, unresolved)--> ../../../../nls.js

- vscode-scale@scale-1788853146362: symbol:06608094c2071284227cd6a2 --export (resolved, syntactic)--> IActionOptions

- vscode-scale@scale-1788853146362: symbol:7821ac6b38b8efb35d84b6b6 --export (resolved, syntactic)--> ActionBar

- vscode-scale@scale-1788853146362: symbol:17f310671e222803d7dd8853 --export (resolved, syntactic)--> BaseActionViewItem

- vscode-scale@scale-1788853146362: vs/base/browser/ui/actionbar/actionViewItems.ts --import (unresolved, unresolved)--> ../../../common/platform.js

- vscode-scale@scale-1788853146362: vs/base/browser/ui/actionbar/actionViewItems.ts --import (unresolved, unresolved)--> ../../../common/lifecycle.js

- vscode-scale@scale-1788853146362: vs/base/browser/ui/actionbar/actionViewItems.ts --import (unresolved, unresolved)--> ../hover/hoverDelegate2.js

## BaseActionViewItem.constructor [implementation]
vscode-scale@scale-1788853146362:vs/base/browser/ui/actionbar/actionViewItems.ts:48:2-69:3
Evidence: source-88829e66aa94c44ceaca8489f863eeea3fc3d127d657f6b8928022ac18a9712a; SHA256: ac1b66f2982269ecb8a24a55c955ff6997870616a1340308c75ef3300772efdd; structural
Representative implementation within actionbar.

```
constructor(
		context: unknown,
		action: IAction,
		protected readonly options: IBaseActionViewItemOptions = {}
	) {
		super();

		this._context = context || this;
		this._action = action;

		if (action instanceof Action) {
			this._register(action.onDidChange(event => {
				if (!this.element) {
					// we have not been rendered yet, so there
					// is no point in updating the UI
					return;
				}

				this.handleActionChangeEvent(event);
			}));
		}
	}
```

## IActionOptions [implementation]
vscode-scale@scale-1788853146362:vs/base/browser/ui/actionbar/actionbar.ts:63:8-65:2
Evidence: source-9e49e12438cc342594fd7832b870d0e4fc5f9491f8346b4afbf233356df4b854; SHA256: 0e7ff63591d002b491c89a451f79606faa40babe18a03efcc4e2cb946edccc9a; structural
Representative implementation within actionbar.

```
interface IActionOptions extends IActionViewItemOptions {
	index?: number;
}
```

## actionBar [implementation]
vscode-scale@scale-1788853146362:vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/components/gutterIndicatorMenu.ts:271:1-285:2
Evidence: source-c13a246c8b23736db56e34829bf090ce2b2f039433ef29d883e047b5158e5318; SHA256: e6fe68fe404905af873b798bc08fefe9fdd931fd6764ea56b0c1a67d93082de9; structural
Representative implementation within components.

```
function actionBar(actions: IAction[], options: IActionBarOptions) {
	return derived({ name: 'inlineEdits.actionBar' }, (_reader) => n.div({
		class: ['action-widget-action-bar'],
		style: {
			padding: '3px 24px',
		}
	}, [
		n.div({
			ref: elem => {
				const actionBar = _reader.store.add(new ActionBar(elem, options));
				actionBar.push(actions, { icon: false, label: true });
			}
		})
	]));
}
```

## SimpleInlineSuggestModel.constructor [implementation]
vscode-scale@scale-1788853146362:vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/components/gutterIndicatorView.ts:93:2-96:7
Evidence: source-d62718c7dd9754529b59abd1557f63de2d7adabc74be00a464242446b492734f; SHA256: 35cd74be94d5ec5b00a86156741b8abe82ebea7c9ae94e4d83b0bf4f7c1fad21; structural
Representative implementation within components.

```
constructor(
		readonly accept: () => void,
		readonly jump: () => void,
	) { }
```

## InlineEditWithChanges.constructor [implementation]
vscode-scale@scale-1788853146362:vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/inlineEditWithChanges.ts:37:2-46:3
Evidence: source-4c0cd75dbdf87e2cd5e7845ac34882eedb18f36e5bc1c32a39ec1607c41b8119; SHA256: 0916a291d9c06851ff202eaef8afe1815b5142d94b5c1aa875e5d52bf9dbe717; structural
Representative implementation within inlineEdits.

```
constructor(
		public readonly originalText: TextModelValueReference,
		public readonly action: InlineSuggestionAction | undefined,
		public readonly edit: TextEdit | undefined,
		public readonly cursorPosition: Position,
		public readonly multiCursorPositions: readonly Position[],
		public readonly commands: readonly InlineCompletionCommand[],
		public readonly inlineCompletion: InlineSuggestionItem,
	) {
	}
```

## observeColor [implementation]
vscode-scale@scale-1788853146362:vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/theme.ts:212:8-228:2
Evidence: source-6711ed55f3aee7cb4542e5c273eee0ccd5dc8f4c4114777e4c05f1eaad0c5ed7; SHA256: bdf9e3c11bc047be658aba3083c54dd5046d31aaecfa000635d70b7747d4f94a; structural
Representative implementation within inlineEdits.

```
function observeColor(colorIdentifier: ColorIdentifier, themeService: IThemeService): IObservable<Color> {
	return observableFromEventOpts(
		{
			owner: { observeColor: colorIdentifier },
			equalsFn: (a: Color, b: Color) => a.equals(b),
			debugName: () => `observeColor(${colorIdentifier})`
		},
		themeService.onDidColorThemeChange,
		() => {
			const color = themeService.getColorTheme().getColor(colorIdentifier);
			if (!color) {
				throw new BugIndicatingError(`Missing color: ${colorIdentifier}`);
			}
			return color;
		}
	);
}
```

## getParsedPromptFile [implementation]
vscode-scale@scale-1788853146362:vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptCodeActions.test.ts:78:4-80:5
Evidence: source-4161e016afec3b1eca64987c92092f8f530f185d5d4eafd4739e505dbbb9d563; SHA256: 757212cadf789c0cab9e220a2175b339456c08ea484265da200969e17087fdd0; structural
Representative implementation within promptCodeActions.test.ts.

```
getParsedPromptFile(model: ITextModel) {
				return parser.parse(model.uri, model.getValue());
			}
```

## IWorkbenchActionBarOptions [implementation]
vscode-scale@scale-1788853146362:vs/platform/actions/browser/actionbar.ts:10:8-16:2
Evidence: source-e4a7f2211ec41bbad06ce8cea5423f24c8236ffe02674a4e209ec90624bc0f85; SHA256: 0ef8cc1a0049b40786c3309904bc8a8ec6dcd19029f139e19c029f727c2f9273; structural
Representative implementation within actions.

```
interface IWorkbenchActionBarOptions extends IActionBarOptions {
	/**
	 * When set the `workbenchActionExecuted` is automatically sent for each invoked action. The `from` property
	 * of the event will be the passed `telemetrySource`-value.
	 */
	telemetrySource?: string;
}
```

## MenuWorkbenchToolBar.onDidChangeMenuItems [implementation]
vscode-scale@scale-1788853146362:vs/platform/actions/browser/toolbar.ts:341:2-341:73
Evidence: source-c0bcf9313bbe7808f934b207dd18c3ab2d298f36e50b32b327ab83613d20f225; SHA256: 96eab362430400f0b329770b10f64f403b976527a649473ff3b358b8533c7e65; structural
Representative implementation within actions.

```
get onDidChangeMenuItems() { return this._onDidChangeMenuItems.event; }
```

## Gaps

- MODULE_CONTEXT_PARTIAL: Only bounded representative implementation excerpts from actionbar were included; this is not its complete source subtree.

- MODULE_CONTEXT_PARTIAL: Only bounded representative implementation excerpts from components were included; this is not its complete source subtree.

- MODULE_CONTEXT_PARTIAL: Only bounded representative implementation excerpts from inlineEdits were included; this is not its complete source subtree.

- MODULE_CONTEXT_PARTIAL: Only bounded representative implementation excerpts from ui were included; this is not its complete source subtree.

- MODULE_CONTEXT_PARTIAL: Only bounded representative implementation excerpts from promptCodeActions.test.ts were included; this is not its complete source subtree.

- MODULE_CONTEXT_PARTIAL: Only bounded representative implementation excerpts from actions were included; this is not its complete source subtree.

- MODULE_CONTEXT_PARTIAL: Only bounded representative implementation excerpts from Local files were included; this is not its complete source subtree.

- DEPENDENCY_BUDGET_EXCEEDED: Additional dependencies of actionbar were not expanded.

- UNRESOLVED_DEPENDENCY: vs/base/browser/ui/actionbar/actionbar.ts: ../hover/hoverDelegateFactory.js is unresolved.

- UNRESOLVED_DEPENDENCY: vs/base/browser/ui/actionbar/actionbar.ts: ../../../common/keyCodes.js is unresolved.

- UNRESOLVED_DEPENDENCY: vs/base/browser/ui/actionbar/actionViewItems.ts: ../../../common/actions.js is unresolved.

- UNRESOLVED_DEPENDENCY: vs/base/browser/ui/actionbar/actionViewItems.ts: ../../../../nls.js is unresolved.

- UNRESOLVED_DEPENDENCY: vs/base/browser/ui/actionbar/actionViewItems.ts: ../../../common/platform.js is unresolved.

- UNRESOLVED_DEPENDENCY: vs/base/browser/ui/actionbar/actionViewItems.ts: ../../../common/lifecycle.js is unresolved.

- UNRESOLVED_DEPENDENCY: vs/base/browser/ui/actionbar/actionViewItems.ts: ../hover/hoverDelegate2.js is unresolved.

- SOURCE_TRUNCATED: Source excerpt is truncated: vs/base/browser/ui/actionbar/actionbar.ts

- DEPENDENCY_BUDGET_EXCEEDED: Additional dependencies of components were not expanded.

- UNRESOLVED_DEPENDENCY: vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/components/gutterIndicatorMenu.ts: ../../../../../../../nls.js is unresolved.

- UNRESOLVED_DEPENDENCY: vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/components/gutterIndicatorMenu.ts: ./gutterIndicatorView.js is unresolved.

- UNRESOLVED_DEPENDENCY: vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/components/gutterIndicatorMenu.ts: ../../../../../../../platform/theme/common/colorRegistry.js is unresolved.

- UNRESOLVED_DEPENDENCY: vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/components/gutterIndicatorMenu.ts: ../../../../../../browser/observableCodeEditor.js is unresolved.

- UNRESOLVED_DEPENDENCY: vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/components/gutterIndicatorView.ts: ./gutterIndicatorMenu.js is unresolved.

- UNRESOLVED_DEPENDENCY: vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/components/gutterIndicatorView.ts: ../../../model/InlineSuggestAlternativeAction.js is unresolved.

- UNRESOLVED_DEPENDENCY: vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/components/gutterIndicatorView.ts: ../../../../../../browser/observableCodeEditor.js is unresolved.

- UNRESOLVED_DEPENDENCY: vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/components/gutterIndicatorView.ts: ../../../../../../common/core/2d/rect.js is unresolved.

- UNRESOLVED_DEPENDENCY: vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/components/gutterIndicatorMenu.ts: ../../../../../../../base/common/codicons.js is unresolved.

- UNRESOLVED_DEPENDENCY: vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/components/gutterIndicatorMenu.ts: ../../../../../../../base/common/keybindings.js is unresolved.

- UNRESOLVED_DEPENDENCY: vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/components/gutterIndicatorView.ts: ../theme.js is unresolved.

- DEPENDENCY_BUDGET_EXCEEDED: Additional dependencies of inlineEdits were not expanded.

- UNRESOLVED_DEPENDENCY: vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/inlineEditsViews/inlineEditsWordReplacementView.ts: ../../../../../../../platform/keybinding/common/keybinding.js is unresolved.

- UNRESOLVED_DEPENDENCY: vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/inlineEditsViewInterface.ts: ../../../../../../base/common/event.js is unresolved.

- UNRESOLVED_DEPENDENCY: vs/editor/contrib/inlineCompletions/browser/view/inlineEdits/inlineEditsViews/inlineEditsInsertionView.ts: ../../../../../../../base/common/event.js is unresolved.

- CONTEXT_METADATA_TRUNCATED: Some result or relation metadata was omitted to preserve the source evidence budget.

- CONTEXT_BUDGET_EXCEEDED: Additional source evidence was omitted to respect the context budget. Narrow the task or increase the budget.