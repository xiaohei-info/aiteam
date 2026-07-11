import { type FormEvent, useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useI18n } from "../../i18n/context";

interface Props {
  onSubmit: (name: string, phone: string, code: string) => Promise<boolean>;
  loading: boolean;
  error: string | null;
}

export function ProvisionForm({ onSubmit, loading, error }: Props): ReactNode {
  const i18n = useI18n();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setValidationError(null);
    if (!name.trim()) {
      setValidationError(i18n.t("operation.enterprise.name_required"));
      return;
    }
    if (!phone.trim()) {
      setValidationError(i18n.t("operation.enterprise.phone_required"));
      return;
    }
    const succeeded = await onSubmit(name.trim(), phone.trim(), code.trim());
    if (succeeded) {
      setName("");
      setPhone("");
      setCode("");
    }
  }

  return (
    <Card>
      <form aria-label={i18n.t("operation.enterprise.provision")} onSubmit={(event) => void handleSubmit(event)}>
        <VStack gap={4}>
          <Heading level={2}>{i18n.t("operation.enterprise.provision")}</Heading>
          <FormLayout>
            <TextInput
              label={i18n.t("operation.enterprise.name")}
              value={name}
              onChange={setName}
              placeholder={i18n.t("operation.enterprise.name")}
              isRequired
              isDisabled={loading}
            />
            <TextInput
              label={i18n.t("operation.enterprise.phone")}
              value={phone}
              onChange={setPhone}
              placeholder="负责人手机号"
              isRequired
              isDisabled={loading}
            />
            <TextInput
              label={i18n.t("operation.enterprise.code")}
              value={code}
              onChange={setCode}
              placeholder="enterprise_code（可选）"
              isOptional
              isDisabled={loading}
            />
          </FormLayout>
          {(validationError ?? error) && <Banner status="error" title={(validationError ?? error)!} />}
          <HStack justify="end">
            <Button
              label={loading ? i18n.t("operation.enterprise.submitting") : i18n.t("operation.enterprise.submit")}
              type="submit"
              variant="primary"
              isLoading={loading}
            />
          </HStack>
        </VStack>
      </form>
    </Card>
  );
}
