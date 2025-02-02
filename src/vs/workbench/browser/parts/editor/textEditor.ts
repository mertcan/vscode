/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { URI } from 'vs/base/common/uri';
import { distinct, deepClone, assign } from 'vs/base/common/objects';
import { isObject, assertIsDefined, withNullAsUndefined, isFunction } from 'vs/base/common/types';
import { Dimension } from 'vs/base/browser/dom';
import { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';
import { EditorInput, EditorOptions, IEditorMemento, ITextEditor, SaveReason, TextEditorOptions } from 'vs/workbench/common/editor';
import { BaseEditor } from 'vs/workbench/browser/parts/editor/baseEditor';
import { IEditorViewState, IEditor, ScrollType } from 'vs/editor/common/editorCommon';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { ITextResourceConfigurationService } from 'vs/editor/common/services/resourceConfiguration';
import { IEditorOptions } from 'vs/editor/common/config/editorOptions';
import { isDiffEditor, isCodeEditor, getCodeEditor } from 'vs/editor/browser/editorBrowser';
import { IEditorGroupsService, IEditorGroup } from 'vs/workbench/services/editor/common/editorGroupsService';
import { CancellationToken } from 'vs/base/common/cancellation';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IFilesConfigurationService, AutoSaveMode } from 'vs/workbench/services/filesConfiguration/common/filesConfigurationService';

const TEXT_EDITOR_VIEW_STATE_PREFERENCE_KEY = 'textEditorViewState';

export interface IEditorConfiguration {
	editor: object;
	diffEditor: object;
}

/**
 * The base class of editors that leverage the text editor for the editing experience. This class is only intended to
 * be subclassed and not instantiated.
 */
export abstract class BaseTextEditor extends BaseEditor implements ITextEditor {
	private editorControl: IEditor | undefined;
	private editorContainer: HTMLElement | undefined;
	private hasPendingConfigurationChange: boolean | undefined;
	private lastAppliedEditorOptions?: IEditorOptions;
	private editorMemento: IEditorMemento<IEditorViewState>;

	constructor(
		id: string,
		@ITelemetryService telemetryService: ITelemetryService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@ITextResourceConfigurationService private readonly _configurationService: ITextResourceConfigurationService,
		@IThemeService protected themeService: IThemeService,
		@IEditorService protected editorService: IEditorService,
		@IEditorGroupsService protected editorGroupService: IEditorGroupsService,
		@IFilesConfigurationService private readonly filesConfigurationService: IFilesConfigurationService
	) {
		super(id, telemetryService, themeService, storageService);

		this.editorMemento = this.getEditorMemento<IEditorViewState>(editorGroupService, TEXT_EDITOR_VIEW_STATE_PREFERENCE_KEY, 100);

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			const resource = this.getResource();
			const value = resource ? this.configurationService.getValue<IEditorConfiguration>(resource) : undefined;
			return this.handleConfigurationChangeEvent(value);
		}));
	}

	protected get instantiationService(): IInstantiationService {
		return this._instantiationService;
	}

	protected get configurationService(): ITextResourceConfigurationService {
		return this._configurationService;
	}

	protected handleConfigurationChangeEvent(configuration?: IEditorConfiguration): void {
		if (this.isVisible()) {
			this.updateEditorConfiguration(configuration);
		} else {
			this.hasPendingConfigurationChange = true;
		}
	}

	private consumePendingConfigurationChangeEvent(): void {
		if (this.hasPendingConfigurationChange) {
			this.updateEditorConfiguration();
			this.hasPendingConfigurationChange = false;
		}
	}

	protected computeConfiguration(configuration: IEditorConfiguration): IEditorOptions {

		// Specific editor options always overwrite user configuration
		const editorConfiguration: IEditorOptions = isObject(configuration.editor) ? deepClone(configuration.editor) : Object.create(null);
		assign(editorConfiguration, this.getConfigurationOverrides());

		// ARIA label
		editorConfiguration.ariaLabel = this.computeAriaLabel();

		return editorConfiguration;
	}

	private computeAriaLabel(): string {
		let ariaLabel = this.getAriaLabel();

		// Apply group information to help identify in which group we are
		if (ariaLabel) {
			if (this.group) {
				ariaLabel = localize('editorLabelWithGroup', "{0}, {1}.", ariaLabel, this.group.label);
			}
		}

		return ariaLabel;
	}

	protected getConfigurationOverrides(): IEditorOptions {
		return {
			overviewRulerLanes: 3,
			lineNumbersMinChars: 3,
			fixedOverflowWidgets: true,
			readOnly: this.input?.isReadonly()
		};
	}

	protected createEditor(parent: HTMLElement): void {

		// Editor for Text
		this.editorContainer = parent;
		this.editorControl = this._register(this.createEditorControl(parent, this.computeConfiguration(this.configurationService.getValue<IEditorConfiguration>(this.getResource()))));

		// Model & Language changes
		const codeEditor = getCodeEditor(this.editorControl);
		if (codeEditor) {
			this._register(codeEditor.onDidChangeModelLanguage(() => this.updateEditorConfiguration()));
			this._register(codeEditor.onDidChangeModel(() => this.updateEditorConfiguration()));
		}

		// Application & Editor focus change to respect auto save settings
		if (isCodeEditor(this.editorControl)) {
			this._register(this.editorControl.onDidBlurEditorWidget(() => this.onEditorFocusLost()));
		} else if (isDiffEditor(this.editorControl)) {
			this._register(this.editorControl.getOriginalEditor().onDidBlurEditorWidget(() => this.onEditorFocusLost()));
			this._register(this.editorControl.getModifiedEditor().onDidBlurEditorWidget(() => this.onEditorFocusLost()));
		}
	}

	private onEditorFocusLost(): void {
		this.maybeTriggerSaveAll(SaveReason.FOCUS_CHANGE);
	}

	private maybeTriggerSaveAll(reason: SaveReason): void {
		const mode = this.filesConfigurationService.getAutoSaveMode();

		// Determine if we need to save all. In case of a window focus change we also save if auto save mode
		// is configured to be ON_FOCUS_CHANGE (editor focus change)
		if (reason === SaveReason.FOCUS_CHANGE && mode === AutoSaveMode.ON_FOCUS_CHANGE) {
			const input = this.input;
			const group = this.group;

			if (input?.isDirty() && group) {
				this.editorService.save([{ groupId: group.id, editor: input }], { reason });
			}
		}
	}

	/**
	 * This method creates and returns the text editor control to be used. Subclasses can override to
	 * provide their own editor control that should be used (e.g. a DiffEditor).
	 *
	 * The passed in configuration object should be passed to the editor control when creating it.
	 */
	protected createEditorControl(parent: HTMLElement, configuration: IEditorOptions): IEditor {

		// Use a getter for the instantiation service since some subclasses might use scoped instantiation services
		return this.instantiationService.createInstance(CodeEditorWidget, parent, configuration, {});
	}

	async setInput(input: EditorInput, options: EditorOptions | undefined, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, token);

		// Update editor options after having set the input. We do this because there can be
		// editor input specific options (e.g. an ARIA label depending on the input showing)
		this.updateEditorConfiguration();

		const editorContainer = assertIsDefined(this.editorContainer);
		editorContainer.setAttribute('aria-label', this.computeAriaLabel());
	}

	setOptions(options: EditorOptions | undefined): void {
		const textOptions = options as TextEditorOptions;
		if (textOptions && isFunction(textOptions.apply)) {
			const textEditor = assertIsDefined(this.getControl());
			textOptions.apply(textEditor, ScrollType.Smooth);
		}
	}

	protected setEditorVisible(visible: boolean, group: IEditorGroup | undefined): void {

		// Pass on to Editor
		const editorControl = assertIsDefined(this.editorControl);
		if (visible) {
			this.consumePendingConfigurationChangeEvent();
			editorControl.onVisible();
		} else {
			editorControl.onHide();
		}

		super.setEditorVisible(visible, group);
	}

	focus(): void {

		// Pass on to Editor
		const editorControl = assertIsDefined(this.editorControl);
		editorControl.focus();
	}

	layout(dimension: Dimension): void {

		// Pass on to Editor
		const editorControl = assertIsDefined(this.editorControl);
		editorControl.layout(dimension);
	}

	getControl(): IEditor | undefined {
		return this.editorControl;
	}

	/**
	 * Saves the text editor view state for the given resource.
	 */
	protected saveTextEditorViewState(resource: URI): void {
		const editorViewState = this.retrieveTextEditorViewState(resource);
		if (!editorViewState || !this.group) {
			return;
		}

		this.editorMemento.saveEditorState(this.group, resource, editorViewState);
	}

	getViewState(): IEditorViewState | undefined {
		const resource = this.input?.getResource();
		if (resource) {
			return withNullAsUndefined(this.retrieveTextEditorViewState(resource));
		}

		return undefined;
	}

	protected retrieveTextEditorViewState(resource: URI): IEditorViewState | null {
		const control = this.getControl();
		if (!isCodeEditor(control)) {
			return null;
		}

		const model = control.getModel();
		if (!model) {
			return null; // view state always needs a model
		}

		const modelUri = model.uri;
		if (!modelUri) {
			return null; // model URI is needed to make sure we save the view state correctly
		}

		if (modelUri.toString() !== resource.toString()) {
			return null; // prevent saving view state for a model that is not the expected one
		}

		return control.saveViewState();
	}

	/**
	 * Clears the text editor view state for the given resources.
	 */
	protected clearTextEditorViewState(resources: URI[], group?: IEditorGroup): void {
		resources.forEach(resource => {
			this.editorMemento.clearEditorState(resource, group);
		});
	}

	/**
	 * Loads the text editor view state for the given resource and returns it.
	 */
	protected loadTextEditorViewState(resource: URI): IEditorViewState | undefined {
		return this.group ? this.editorMemento.loadEditorState(this.group, resource) : undefined;
	}

	private updateEditorConfiguration(configuration?: IEditorConfiguration): void {
		if (!configuration) {
			const resource = this.getResource();
			if (resource) {
				configuration = this.configurationService.getValue<IEditorConfiguration>(resource);
			}
		}

		if (!this.editorControl || !configuration) {
			return;
		}

		const editorConfiguration = this.computeConfiguration(configuration);

		// Try to figure out the actual editor options that changed from the last time we updated the editor.
		// We do this so that we are not overwriting some dynamic editor settings (e.g. word wrap) that might
		// have been applied to the editor directly.
		let editorSettingsToApply = editorConfiguration;
		if (this.lastAppliedEditorOptions) {
			editorSettingsToApply = distinct(this.lastAppliedEditorOptions, editorSettingsToApply);
		}

		if (Object.keys(editorSettingsToApply).length > 0) {
			this.lastAppliedEditorOptions = editorConfiguration;
			this.editorControl.updateOptions(editorSettingsToApply);
		}
	}

	protected getResource(): URI | undefined {
		const codeEditor = getCodeEditor(this.editorControl);
		if (codeEditor) {
			const model = codeEditor.getModel();
			if (model) {
				return model.uri;
			}
		}

		if (this.input) {
			return this.input.getResource();
		}

		return undefined;
	}

	protected abstract getAriaLabel(): string;

	dispose(): void {
		this.lastAppliedEditorOptions = undefined;

		super.dispose();
	}
}
