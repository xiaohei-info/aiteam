import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";

export interface BasicInfoFieldsProps {
  displayName: string;
  showCategory: boolean;
  category: string;
  categories: string[];
  newCategory: string;
  isAddingCategory: boolean;
  disabled: boolean;
  displayNameError?: string;
  categoryError?: string;
  onDisplayNameChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onNewCategoryChange: (value: string) => void;
  onAddingCategoryChange: (value: boolean) => void;
  onAddCategory: () => void;
}

export function BasicInfoFields({
  displayName,
  showCategory,
  category,
  categories,
  newCategory,
  isAddingCategory,
  disabled,
  displayNameError,
  categoryError,
  onDisplayNameChange,
  onCategoryChange,
  onNewCategoryChange,
  onAddingCategoryChange,
  onAddCategory,
}: BasicInfoFieldsProps) {
  return (
    <FormLayout>
      <TextInput
        label="名称"
        value={displayName}
        onChange={onDisplayNameChange}
        placeholder="display_name"
        isRequired
        isDisabled={disabled}
        status={displayNameError ? { type: "error", message: displayNameError } : undefined}
      />
      {showCategory && (
        <>
          <Selector
            label="分类 (category)"
            value={category || undefined}
            onChange={onCategoryChange}
            options={categories.map((value) => ({ value, label: value }))}
            placeholder="请选择分类"
            isDisabled={disabled}
            status={categoryError ? { type: "error", message: categoryError } : undefined}
          />
          <VStack gap={2} align="start">
            <Button
              label={isAddingCategory ? "取消新增分类" : "新建分类"}
              variant="ghost"
              onClick={() => onAddingCategoryChange(!isAddingCategory)}
              isDisabled={disabled}
            />
            {isAddingCategory && (
              <TextInput
                label="新分类名称"
                value={newCategory}
                onChange={onNewCategoryChange}
                placeholder="输入新分类名称"
                isDisabled={disabled}
              />
            )}
            {isAddingCategory && (
              <Button
                label="添加"
                variant="secondary"
                onClick={onAddCategory}
                isDisabled={disabled || !newCategory.trim()}
              />
            )}
          </VStack>
        </>
      )}
    </FormLayout>
  );
}
